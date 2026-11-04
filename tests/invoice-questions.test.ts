/**
 * 確認事項を聞き返す単位にまとめる部分（toQuestions）の検証。Claude は呼ばない。
 * 参照は、本物の Opus が架空の録音に返した参照（2026-11-04、①〜⑥b と tire-003）と同じ形を手で書いた。
 * 素材は架空の文字起こし（tire-transcripts.json）と、この試験の中で作る架空の録音。証明には使わない。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assembleInvoice } from "../lib/invoice/build";
import { type Candidate, enumerateCandidates } from "../lib/invoice/candidates";
import { type Question, QUESTION_REASONS, reasonOf, toQuestions } from "../lib/invoice/questions";
import type { InvoiceRefs, LineRef } from "../lib/invoice/schema";
import { ledgerEntries, parseLedgerBook } from "../lib/ledger/lookup";
import type { Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = ledgerEntries(parseLedgerBook(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8"))));
const transcripts = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/tire-transcripts.json"), "utf8"),
) as Transcript[];

/** 3 秒ずつの発話の架空の録音（話者は父）。 */
const seq = (...texts: string[]): Transcript => ({
  recordingId: "adv",
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: texts.map((text, i) => ({ startSec: i * 3, endSec: i * 3 + 3, speaker: "father", text })),
});

const id = (cs: Candidate[], kind: Candidate["kind"], seg: number, text: string, nth = 0): string => {
  const hit = cs.filter((c) => c.kind === kind && c.seg === seg && c.text === text)[nth];
  if (!hit) throw new Error(`候補が無い: ${kind} #${seg} ${text} ${nth}`);
  return hit.id;
};

const ref = (item: LineRef["item"], qty: string | null, over: Partial<LineRef> = {}): LineRef => ({
  item,
  qty,
  unitPrice: null,
  amount: null,
  status: "done",
  evidence: [],
  correctedFrom: null,
  correctedTo: null,
  ...over,
});

const run = (t: Transcript, mk: (cs: Candidate[]) => InvoiceRefs) => {
  const cs = enumerateCandidates(t, ledger);
  const r = assembleInvoice({ candidates: cs, ...mk(cs) }, t, ledger);
  return { r, qs: toQuestions(r, cs, t, ledger) };
};

/** 確認事項が 1 件も落ちず、重ならずに、どれかの質問に入る。行ごとに 1 問、-1 は理由ごとに 1 問。質問は 40 字まで。 */
function assertShape(r: { confirmations: { lineIndex: number }[] }, qs: Question[]) {
  assert.deepEqual(
    qs.flatMap((q) => q.confirmations).map((c) => JSON.stringify(c)).sort(),
    r.confirmations.map((c) => JSON.stringify(c)).sort(),
  );
  const lineIdx = qs.filter((q) => q.lineIndex >= 0).map((q) => q.lineIndex);
  assert.deepEqual(lineIdx, [...new Set(r.confirmations.map((c) => c.lineIndex).filter((i) => i >= 0))].sort((a, b) => a - b));
  const globals = qs.filter((q) => q.lineIndex === -1).map((q) => q.reason);
  assert.equal(new Set(globals).size, globals.length);
  for (const q of qs) {
    assert.ok(q.text.length <= 40, `長い: ${q.text}`);
    assert.ok(q.confirmations.every((c) => c.lineIndex === q.lineIndex));
    assert.equal(q.reason, q.reasons[0]);
    assert.deepEqual(q.reasons, [...new Set(q.confirmations.map(reasonOf))].sort((a, b) => QUESTION_REASONS.indexOf(a) - QUESTION_REASONS.indexOf(b)));
  }
}

test("tire-001・tire-002: 確認事項が無ければ質問も無い", () => {
  for (const rid of ["tire-001", "tire-002"]) {
    const t = transcripts.find((x) => x.recordingId === rid)!;
    const cs = enumerateCandidates(t, ledger);
    const lines =
      rid === "tire-001"
        ? [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref(id(cs, "item", 1, "バランス"), id(cs, "qty", 1, "4本"))]
        : [
            ref(id(cs, "item", 0, "組替"), id(cs, "qty", 0, "4本")),
            ref(id(cs, "item", 1, "バランス"), id(cs, "qty", 1, "4本", 0)),
            ref(id(cs, "item", 1, "ゴムバルブ"), id(cs, "qty", 1, "4本", 1), { unitPrice: id(cs, "unitPrice", 2, "1本330円") }),
            ref(id(cs, "item", 3, "廃タイヤ"), id(cs, "qty", 3, "4本")),
          ];
    const r = assembleInvoice({ candidates: cs, lines, negations: [] }, t, ledger);
    assert.equal(r.total, rid === "tire-001" ? 6600 : 13640);
    assert.deepEqual(toQuestions(r, cs, t, ledger), []);
  }
});

test("tire-003 の形: 脱着は使われない 2個 を、ホイールナットは単価を、行ごとに 1 問で聞く", () => {
  const t = transcripts.find((x) => x.recordingId === "tire-003")!;
  const { r, qs } = run(t, (cs) => ({
    lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref({ seg: 1, text: "ホイールナット" }, id(cs, "qty", 1, "2個", 1))],
    negations: [],
  }));
  assertShape(r, qs);
  assert.deepEqual(qs.map((q) => [q.lineIndex, q.reason, q.text]), [
    [0, "correction", "脱着は4本ですか。2個は何の数ですか"],
    [1, "unitPrice", "ホイールナットの単価はいくらですか"],
  ]);
});

test("① 同じ発話の言い直し: 確認事項 6 件が 1 問「脱着は4本と2本のどちらですか」", () => {
  const { r, qs } = run(seq("冬タイヤ替えるはんで、脱着4本…いや2本だな。", "バランスも2本。"), (cs) => {
    const [q4, q2] = [id(cs, "qty", 0, "4本"), id(cs, "qty", 0, "2本")];
    return {
      lines: [
        ref(id(cs, "item", 0, "脱着"), null, { status: "corrected", evidence: [q4, q2], correctedFrom: q4, correctedTo: q2 }),
        ref(id(cs, "item", 1, "バランス"), id(cs, "qty", 1, "2本")),
      ],
      negations: [],
    };
  });
  assertShape(r, qs);
  assert.ok(r.confirmations.length >= 5, JSON.stringify(r.confirmations));
  assert.equal(qs.length, 1);
  assert.equal(qs[0].lineIndex, 0);
  assert.equal(qs[0].reason, "correction");
  assert.equal(qs[0].text, "脱着は4本と2本のどちらですか");
  assert.equal(qs[0].confirmations.length, r.confirmations.length);
});

test("② 発話をまたぐ言い直し: 脱着は 4本と2本のどちらか、数量の無いバランスは何本か、の 2 問", () => {
  const { r, qs } = run(seq("脱着4本。", "いや2本。", "バランスも。"), (cs) => {
    const [q4, q2] = [id(cs, "qty", 0, "4本"), id(cs, "qty", 1, "2本")];
    return {
      lines: [
        ref(id(cs, "item", 0, "脱着"), null, { status: "corrected", evidence: [q4, q2], correctedFrom: q4, correctedTo: q2 }),
        ref(id(cs, "item", 2, "バランス"), null),
      ],
      negations: [],
    };
  });
  assertShape(r, qs);
  assert.deepEqual(qs.map((q) => [q.lineIndex, q.reason, q.text]), [
    [0, "correction", "脱着は4本と2本のどちらですか"],
    [1, "qty", "バランスは何本ですか"],
  ]);
});

test("③ 言ってから打ち消す: 否定が言い直しより優先し「ゴムバルブの4本は替えなかったのですか」", () => {
  const { r, qs } = run(seq("組替4本。", "ゴムバルブ4本替えた、いや替えてない。"), (cs) => {
    const [i2, q2] = [id(cs, "item", 1, "ゴムバルブ"), id(cs, "qty", 1, "4本")];
    return {
      lines: [ref(id(cs, "item", 0, "組替"), id(cs, "qty", 0, "4本")), ref(i2, q2, { status: "negated", evidence: [i2, q2] })],
      negations: [{ seg: 1, text: "いや替えてない。" }],
    };
  });
  assertShape(r, qs);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].lineIndex, 1);
  assert.deepEqual(qs[0].reasons.slice(0, 2), ["negation", "correction"]);
  assert.equal(qs[0].text, "ゴムバルブの4本は替えなかったのですか");
});

test("④ 断り: 数量の無い否定の行は、数を入れずに「ゴムバルブは替えなかったのですか」", () => {
  const { r, qs } = run(seq("組替4本と、バランス4本な。", "ゴムバルブも替えるが？", "バルブは大丈夫です。"), (cs) => {
    const i3 = id(cs, "item", 1, "ゴムバルブ");
    return {
      lines: [
        ref(id(cs, "item", 0, "組替"), id(cs, "qty", 0, "4本")),
        ref(id(cs, "item", 0, "バランス"), id(cs, "qty", 0, "4本", 1)),
        ref(i3, null, { status: "negated", evidence: [i3] }),
      ],
      negations: [{ seg: 2, text: "バルブは大丈夫です。" }],
    };
  });
  assertShape(r, qs);
  // 「バルブ」は料金表の語でない（品目の語が無い）が、20 秒以内の negated の行に付くので 1 問（条件 18 の (3)）
  assert.deepEqual(qs.map((q) => [q.lineIndex, q.reason, q.text]), [[2, "negation", "ゴムバルブは替えなかったのですか"]]);
  assert.ok(qs[0].confirmations.some((c) => c.message.includes("バルブは大丈夫です。")), JSON.stringify(qs[0].confirmations));
  assert.ok(qs[0].reasons.includes("qty"));
});

test("否定: 交換でない品目は「やらなかった」、行の数量の値を入れる", () => {
  const { r, qs } = run(seq("バランスは大丈夫です。4本。"), (cs) => ({
    lines: [ref(id(cs, "item", 0, "バランス"), id(cs, "qty", 0, "4本"))],
    negations: [{ seg: 0, text: "大丈夫です" }],
  }));
  assertShape(r, qs);
  assert.deepEqual(qs.map((q) => [q.lineIndex, q.reason, q.text]), [[0, "negation", "バランスの4本はやらなかったのですか"]]);
});

test("⑤ 言った合計が違う（1万2000円）: 行に付かない合計の 1 問、言った額と計算の額を入れる", () => {
  const { r, qs } = run(seq("組替4本、バランス4本。", "全部で1万2000円くらいだべな。"), (cs) => ({
    lines: [ref(id(cs, "item", 0, "組替"), id(cs, "qty", 0, "4本")), ref(id(cs, "item", 0, "バランス"), id(cs, "qty", 0, "4本", 1))],
    negations: [],
  }));
  assertShape(r, qs);
  assert.deepEqual(qs.map((q) => [q.lineIndex, q.reason, q.text]), [[-1, "total", "合計は12000円と11000円のどちらですか"]]);
});

test("⑥b 言った合計が違う（7000円）: 「合計は7000円と6600円のどちらですか」", () => {
  const { r, qs } = run(seq("脱着4本、バランス4本だはんで。", "合計で7000円な。"), (cs) => ({
    lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref(id(cs, "item", 0, "バランス"), id(cs, "qty", 0, "4本", 1))],
    negations: [],
  }));
  assertShape(r, qs);
  assert.deepEqual(qs.map((q) => q.text), ["合計は7000円と6600円のどちらですか"]);
});

test("D3 の形: done で訂正欄を書いた行も、言い直しの 1 問に訂正前・訂正後の値が入る", () => {
  const { r, qs } = run(seq("脱着4本。", "訂正、2本。", "バランスも。"), (cs) => {
    const [q4, q2] = [id(cs, "qty", 0, "4本"), id(cs, "qty", 1, "2本")];
    return {
      lines: [ref(id(cs, "item", 0, "脱着"), q4, { correctedFrom: q4, correctedTo: q2 }), ref(id(cs, "item", 2, "バランス"), q2)],
      negations: [],
    };
  });
  assertShape(r, qs);
  assert.deepEqual(qs.map((q) => [q.lineIndex, q.text]), [[0, "脱着は4本と2本のどちらですか"]]);
});

test("行に付かない事項は理由ごとに 1 問: 使われない金額・読めない数・行の無い品目", () => {
  const { r, qs } = run(seq("脱着4本。", "ナット交換4本、1本500円。", "バランスもな。", "あと.2本と二二十円。"), (cs) => ({
    lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))],
    negations: [],
  }));
  assertShape(r, qs);
  const g = qs.filter((q) => q.lineIndex === -1).map((q) => [q.reason, q.text]);
  assert.deepEqual(g, [
    ["unparsed", "聞き取れない数が2か所あります。何と言いましたか"],
    ["unitPrice", "1本500円はどの作業の値段ですか"],
    ["ledger", "バランスもやりましたか"],
  ]);
  // 読めない数の 1 問に 2 件入る
  assert.equal(qs.find((q) => q.reason === "unparsed")!.confirmations.length, 2);
});

test("行が 0 件: 「請求する作業はありませんか」の 1 問。N2 は否定の文の確かめ「バランスはやらないのですね」が加わる", () => {
  const empty = run(seq("こんにちは。"), () => ({ lines: [], negations: [] }));
  assertShape(empty.r, empty.qs);
  assert.deepEqual(empty.qs.map((q) => [q.lineIndex, q.reason, q.text]), [[-1, "total", "請求する作業はありませんか"]]);
  const n2 = run(seq("バランスは大丈夫です。"), () => ({ lines: [], negations: [{ seg: 0, text: "バランスは大丈夫です。" }] }));
  assertShape(n2.r, n2.qs);
  assert.deepEqual(n2.qs.map((q) => [q.lineIndex, q.reason, q.text]), [
    [-1, "negation", "バランスはやらないのですね"],
    [-1, "total", "請求する作業はありませんか"],
  ]);
});

test("否定の文の品目の行が無い（脱着 done、「やっぱりやめて、バランスだけにします。」）: total null、確かめの 1 問", () => {
  const { r, qs } = run(seq("脱着4本。", "やっぱりやめて、バランスだけにします。"), (cs) => ({
    lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))],
    negations: [{ seg: 1, text: "やっぱりやめて、バランスだけにします。" }],
  }));
  assertShape(r, qs);
  assert.equal(r.total, null);
  assert.deepEqual(qs.filter((q) => q.reason === "negation").map((q) => [q.lineIndex, q.text]), [[-1, "バランスはやらないのですね"]]);
});

test("二重の行の数は料金表の正式名にそろえて数える（ID と {seg,text} の混在・3 つの別名）", () => {
  const mixed = run(seq("脱着4本。", "脱着2本。"), (cs) => ({
    lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref({ seg: 1, text: "脱着" }, id(cs, "qty", 1, "2本"))],
    negations: [],
  }));
  assertShape(mixed.r, mixed.qs);
  assert.ok(mixed.qs.every((q) => q.text !== "脱着が1行あります。別の作業ですか"), JSON.stringify(mixed.qs.map((q) => q.text)));
  assert.ok(mixed.qs.some((q) => q.lineIndex === 1 && q.text === "脱着が2行あります。別の作業ですか"), JSON.stringify(mixed.qs.map((q) => q.text)));
  const aliases = run(seq("脱着1本。", "履き替え2本。", "タイヤ脱着3本。"), (cs) => ({
    lines: [
      ref({ seg: 0, text: "脱着" }, id(cs, "qty", 0, "1本")),
      ref({ seg: 1, text: "履き替え" }, id(cs, "qty", 1, "2本")),
      ref({ seg: 2, text: "タイヤ脱着" }, id(cs, "qty", 2, "3本")),
    ],
    negations: [],
  }));
  assertShape(aliases.r, aliases.qs);
  assert.deepEqual(
    aliases.qs.map((q) => [q.lineIndex, q.reason, q.text]),
    [
      [0, "ledger", "脱着が3行あります。別の作業ですか"],
      [1, "ledger", "履き替えが3行あります。別の作業ですか"],
      [2, "ledger", "タイヤ脱着が3行あります。別の作業ですか"],
    ],
  );
});

test("品目の無い否定の文は「何をやめましたか」、2 つなら数を言う。通しで total null", () => {
  const { r, qs } = run(seq("脱着4本。", "やっぱりやめます。"), (cs) => ({
    lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))],
    negations: [{ seg: 1, text: "やっぱりやめます。" }],
  }));
  assertShape(r, qs);
  assert.equal(r.total, null);
  assert.deepEqual(qs.map((q) => [q.lineIndex, q.reason, q.text]), [[-1, "negation", "何をやめましたか"]]);
  const two = run(seq("脱着4本。", "やっぱりやめます。それもいいです。"), (cs) => ({
    lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))],
    negations: [{ seg: 1, text: "やっぱりやめます。" }, { seg: 1, text: "それもいいです。" }],
  }));
  assertShape(two.r, two.qs);
  assert.deepEqual(two.qs.map((q) => q.text), ["やめる話が2つあります。何をやめましたか"]);
});

test("品目の無い否定の文: negated の行が 20 秒より遠ければ、行に付かない「何をやめましたか」のまま", () => {
  const t: Transcript = {
    ...seq(),
    segments: [
      { startSec: 0, endSec: 3, speaker: "father", text: "組替4本。" },
      { startSec: 3, endSec: 6, speaker: "father", text: "ゴムバルブも替えるが？" },
      { startSec: 40, endSec: 43, speaker: "father", text: "バルブは大丈夫です。" },
    ],
  };
  const { r, qs } = run(t, (cs) => {
    const i = id(cs, "item", 1, "ゴムバルブ");
    return {
      lines: [ref(id(cs, "item", 0, "組替"), id(cs, "qty", 0, "4本")), ref(i, null, { status: "negated", evidence: [i] })],
      negations: [{ seg: 2, text: "バルブは大丈夫です。" }],
    };
  });
  assertShape(r, qs);
  assert.deepEqual(qs.map((q) => [q.lineIndex, q.reason, q.text]), [
    [1, "negation", "ゴムバルブは替えなかったのですか"],
    [-1, "negation", "何をやめましたか"],
  ]);
});

test("値を黙って省かない: 使われない金額 3 つは全部、長ければ「など N つ」、二重の行は実際の行数、その他は件数", () => {
  const p3 = run(seq("脱着4本。", "500円、600円、700円。"), (cs) => ({ lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))], negations: [] }));
  assertShape(p3.r, p3.qs);
  assert.deepEqual(p3.qs.map((q) => q.text), ["500円・600円・700円はどの作業の値段ですか"]);
  const many = run(seq("脱着4本。", "1500円、1600円、1700円、1800円、1900円、2100円。"), (cs) => ({
    lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))],
    negations: [],
  }));
  assertShape(many.r, many.qs);
  assert.deepEqual(many.qs.map((q) => q.text), ["1500円など6つはどの作業の値段ですか"]);
  const dup = run(seq("脱着1本。", "脱着2本。", "脱着3本。"), (cs) => ({
    lines: [0, 1, 2].map((i) => ref(id(cs, "item", i, "脱着"), id(cs, "qty", i, `${i + 1}本`))),
    negations: [],
  }));
  assertShape(dup.r, dup.qs);
  assert.deepEqual(dup.qs.map((q) => q.text), Array(3).fill("脱着が3行あります。別の作業ですか"));
  const other = run(seq("脱着4本。"), (cs) => ({
    lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))],
    negations: [{ seg: 0, text: "替えない" }, { seg: 0, text: "いらない" }],
  }));
  assertShape(other.r, other.qs);
  assert.deepEqual(other.qs.map((q) => [q.reason, q.text]), [["other", "「替えない」など2件は、どういうことですか"]]);
  // 行が 0 件と税込みの合計: 税込みの額も質問に入れる
  const zero = run(seq("税込みで7260円。"), () => ({ lines: [], negations: [] }));
  assertShape(zero.r, zero.qs);
  assert.deepEqual(zero.qs.map((q) => q.text), ["請求する作業はありませんか。税込みで7260円は何の合計ですか"]);
});

test("税込みの合計は、税抜きを聞く 1 問", () => {
  const { r, qs } = run(seq("脱着4本、バランス4本。", "税込みで7260円。"), (cs) => ({
    lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref(id(cs, "item", 0, "バランス"), id(cs, "qty", 0, "4本", 1))],
    negations: [],
  }));
  assertShape(r, qs);
  assert.deepEqual(qs.map((q) => [q.lineIndex, q.reason, q.text]), [[-1, "total", "税込みの合計は確かめられません。税抜きでいくらですか"]]);
});

test("単価が料金表と違う行は単価を、単位が料金表と違う行は料金表の単位で数を聞く", () => {
  const { r, qs } = run(seq("脱着4本、1本600円。", "バランス1台。"), (cs) => ({
    lines: [
      ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"), { unitPrice: id(cs, "unitPrice", 0, "1本600円") }),
      ref(id(cs, "item", 1, "バランス"), id(cs, "qty", 1, "1台")),
    ],
    negations: [],
  }));
  assertShape(r, qs);
  assert.deepEqual(qs.map((q) => [q.lineIndex, q.reason, q.text]), [
    [0, "unitPrice", "脱着の単価はいくらですか"],
    [1, "unit", "バランスは何本ですか"],
  ]);
});

test("reasonOf: resolve・price・check の確認事項の文言を、その他に落とさず分ける", () => {
  const cases: [Parameters<typeof reasonOf>[0], string][] = [
    [{ lineIndex: 0, item: "x", field: "line", message: "「x」の行の文に否定の合図がある（否定）" }, "negation"],
    [{ lineIndex: 0, item: "x", field: "line", message: "「x」の行をモデルが言い直しと判定した（言い直し: 4本 → 2本）" }, "correction"],
    [{ lineIndex: 0, item: "x", field: "qty", message: "「x」の行の近く（20 秒以内）に、どの行にも使われていない 2本 がある（言い直し・使われない数）" }, "correction"],
    [{ lineIndex: -1, item: ".4本", field: "qty", message: "「.4本」（数が読めない）" }, "unparsed"],
    [{ lineIndex: -1, item: "二二十円", field: "unitPrice", message: "「二二十円」（円の前の数が読めない）" }, "unparsed"],
    [{ lineIndex: 0, item: "x", field: "qty", message: "「x」の数量が分からない" }, "qty"],
    [{ lineIndex: 0, item: "x", field: "qty", message: "「x」の数量 0.4本 が整数でない（数量が整数でない）" }, "qty"],
    [{ lineIndex: 0, item: "x", field: "unitPrice", message: "「x」の単価が料金表に無い" }, "unitPrice"],
    [{ lineIndex: 0, item: "x", field: "unit", message: "「x」の単位が発話（台）と料金表（本）で違う" }, "unit"],
    [{ lineIndex: 0, item: "x", field: "item", message: "「x」は料金表の 2 つ以上の項目に当たる（別名があいまい）" }, "choice"],
    [{ lineIndex: 0, item: "x", field: "item", message: "「x」の行が 2 つある（同じ作業を二重に請求していないか）" }, "ledger"],
    [{ lineIndex: -1, item: "x", field: "total", message: "「合計7000円」（言った合計と計算が違う: 計算は 6600 円）" }, "total"],
    [{ lineIndex: 0, item: "x", field: "line", message: "「x」の行が前の行と同じ発話の箇所を指している（同じ根拠）" }, "other"],
  ];
  for (const [c, want] of cases) assert.equal(reasonOf(c), want, c.message);
});

test("呼び出しの前後で明細・候補・文字起こしが変わらない", () => {
  const t = seq("脱着4本。", "いや2本。", "バランスも。");
  const cs = enumerateCandidates(t, ledger);
  const r = assembleInvoice(
    { candidates: cs, lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref(id(cs, "item", 2, "バランス"), id(cs, "qty", 1, "2本"))], negations: [] },
    t,
    ledger,
  );
  const before = JSON.stringify([r, cs, t]);
  toQuestions(r, cs, t, ledger);
  assert.equal(JSON.stringify([r, cs, t]), before);
});
