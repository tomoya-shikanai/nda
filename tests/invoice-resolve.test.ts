/**
 * 参照を発話の値に戻す部分（resolveInvoice）の検証。Claude は呼ばない。
 * 候補は enumerateCandidates で作り、参照は手で書く。素材は架空の文字起こし（tire-transcripts.json）と、
 * この試験の中で作る架空の録音（recordingId "adv"）。証明には使わない。
 * 「指摘 N」は敵対レビュー（2026-11-04）の例（旧 tests/invoice-build.test.ts、V4 で旧 verify とともに削除）を参照の形に直したもの。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { type Candidate, enumerateCandidates } from "../lib/invoice/candidates";
import { priceInvoice } from "../lib/invoice/price";
import { MAX_LINE_SEC, NEGATION_CUES, resolveInvoice } from "../lib/invoice/resolve";
import type { LineRef } from "../lib/invoice/schema";
import type { LedgerEntry } from "../lib/ledger/lookup";
import type { Segment, Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8")) as LedgerEntry[];
const transcripts = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/tire-transcripts.json"), "utf8"),
) as Transcript[];
const byId = (id: string) => {
  const t = transcripts.find((x) => x.recordingId === id);
  if (!t) throw new Error(`素材に無い: ${id}`);
  return t;
};

/** 架空の録音。発話は [開始, 終了, 話者, 文]。 */
const rec = (...segs: [number, number, string | null, string][]): Transcript => ({
  recordingId: "adv",
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: segs.map(([startSec, endSec, speaker, text]): Segment => ({ startSec, endSec, speaker, text })),
});

/** seg 番目の発話の、kind・text が合う nth 番目の候補の ID。 */
const id = (cs: Candidate[], kind: Candidate["kind"], seg: number, text: string, nth = 0): string => {
  const hit = cs.filter((c) => c.kind === kind && c.seg === seg && c.text === text)[nth];
  if (!hit) throw new Error(`候補が無い: ${kind} #${seg} ${text} ${nth}`);
  return hit.id;
};

const ref = (item: LineRef["item"], qty: string | null, unitPrice: string | null = null, amount: string | null = null): LineRef => ({
  item,
  qty,
  unitPrice,
  amount,
  status: "done",
  evidence: [],
  correctedFrom: null,
  correctedTo: null,
});

const run = (refs: LineRef[], t: Transcript, l: LedgerEntry[] = ledger) => {
  const cs = enumerateCandidates(t, l);
  return { cs, ...resolveInvoice(refs, cs, t, l) };
};

const has = (cf: { field: string; message: string; lineIndex: number }[], field: string, word: string, lineIndex?: number) =>
  cf.some((c) => c.field === field && c.message.includes(word) && (lineIndex === undefined || c.lineIndex === lineIndex));

// --- (2) fixture の正しい参照 ---

test("tire-001: 正しい参照は確認事項 0 件、料金表の正式名・発話の数量・単位、unused は空", () => {
  const t = byId("tire-001");
  const cs = enumerateCandidates(t, ledger);
  const refs = [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref(id(cs, "item", 1, "バランス"), id(cs, "qty", 1, "4本"))];
  const r = resolveInvoice(refs, cs, t, ledger);
  assert.deepEqual(r.confirmations, []);
  assert.deepEqual(r.unused, []);
  assert.deepEqual(r.lines, [
    {
      item: "タイヤ脱着",
      qty: 4,
      unit: "本",
      unitPrice: null,
      provenance: { recordingId: "tire-001", startSec: 0, endSec: 5, speaker: "father", quote: t.segments[0].text },
    },
    {
      item: "ホイールバランス",
      qty: 4,
      unit: "本",
      unitPrice: null,
      provenance: { recordingId: "tire-001", startSec: 5, endSec: 9, speaker: "father", quote: t.segments[1].text },
    },
  ]);
  assert.equal(priceInvoice({ lines: r.lines }, ledger).total, 6600);
});

test("tire-002: ゴムバルブの行は 2 発話目の 4本 と「1本330円」、確認事項 0 件で unused は空", () => {
  const t = byId("tire-002");
  const cs = enumerateCandidates(t, ledger);
  const refs = [
    ref(id(cs, "item", 0, "組替"), id(cs, "qty", 0, "4本")),
    ref(id(cs, "item", 1, "バランス"), id(cs, "qty", 1, "4本", 0)),
    ref(id(cs, "item", 1, "ゴムバルブ"), id(cs, "qty", 1, "4本", 1), id(cs, "unitPrice", 2, "1本330円")),
    ref(id(cs, "item", 3, "廃タイヤ"), id(cs, "qty", 3, "4本")),
  ];
  const r = resolveInvoice(refs, cs, t, ledger);
  assert.deepEqual(r.confirmations, []);
  assert.deepEqual(r.unused, []);
  assert.deepEqual(
    r.lines.map((l) => [l.item, l.qty, l.unit, l.unitPrice]),
    [
      ["タイヤ組替", 4, "本", null],
      ["ホイールバランス", 4, "本", null],
      ["エアバルブ交換", 4, "本", 330],
      ["廃タイヤ処分", 4, "本", null],
    ],
  );
  assert.deepEqual(r.lines[2].provenance, {
    recordingId: "tire-002",
    startSec: 6,
    endSec: 13,
    speaker: "father",
    quote: t.segments[1].text + t.segments[2].text,
  });
  const p = priceInvoice({ lines: r.lines }, ledger);
  assert.deepEqual(p.confirmations, []);
  assert.equal(p.total, 13640);
});

test("tire-003: 話者が null の発話は unknown", () => {
  const t = byId("tire-003");
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))], cs, t, ledger);
  assert.equal(r.lines[0].provenance.speaker, "unknown");
});

// --- (1) 条件ごと ---

test("条件 1: 数量の参照が null なら「数量が分からない」", () => {
  const t = rec([0, 2, "father", "脱着する。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), null)], cs, t, ledger);
  assert.ok(has(r.confirmations, "qty", "数量が分からない", 0), JSON.stringify(r.confirmations));
  assert.equal(r.lines[0].qty, null);
  assert.equal(r.lines[0].unit, null);
});

test("条件 2: どの行にも使われない単価・金額は lineIndex -1 の確認事項", () => {
  const t = rec([0, 3, "father", "ナット2個、1個330円。"], [3, 6, "father", "クリップ4個で880円。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice(
    [ref({ seg: 0, text: "ナット" }, id(cs, "qty", 0, "2個")), ref({ seg: 1, text: "クリップ" }, id(cs, "qty", 1, "4個"))],
    cs,
    t,
    ledger,
  );
  const missing = r.confirmations.filter((c) => c.lineIndex === -1 && c.field === "unitPrice" && c.message.includes("言った金額がどの行にも使われていない"));
  assert.equal(missing.length, 2, JSON.stringify(r.confirmations));
  assert.deepEqual(r.unused.map((c) => c.kind).sort(), ["amount", "unitPrice"]);
});

test("条件 3: 使われない数量と同じ発話に同じ単位の使われた数量があれば「言い直し」", () => {
  const t = rec([0, 3, "father", "脱着4本…いや2本。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "2本"))], cs, t, ledger);
  assert.equal(r.lines[0].qty, 2);
  assert.deepEqual(r.unused.map((c) => c.text), ["4本"]);
  assert.ok(has(r.confirmations, "qty", "言い直し", 0), JSON.stringify(r.confirmations));
});

test("条件 4: 読めない円は「円の前の数が読めない」", () => {
  const t = rec([0, 3, "father", "ナット2個、1個二二十円。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref({ seg: 0, text: "ナット" }, id(cs, "qty", 0, "2個"))], cs, t, ledger);
  assert.ok(has(r.confirmations, "unitPrice", "円の前の数が読めない", -1), JSON.stringify(r.confirmations));
});

test("条件 5: 「脱着4本はしない。」を行にすると「否定」、行にしなければ確認事項なし", () => {
  const t = rec([0, 3, "father", "脱着4本はしない。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))], cs, t, ledger);
  assert.ok(has(r.confirmations, "line", "否定", 0), JSON.stringify(r.confirmations));

  const none = resolveInvoice([], cs, t, ledger);
  assert.deepEqual(none.confirmations, []);
  assert.deepEqual(none.unused.map((c) => c.text), ["4本"]);
});

test("条件 5: 否定は文ごとに見る（別の文の否定は行に効かない。「、」の先は同じ文）", () => {
  const t = rec([0, 3, "father", "組替はしない。脱着4本。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))], cs, t, ledger);
  assert.deepEqual(r.confirmations, []);
  // 規則 C（2026-11-04）: 「、」では切らない。以前は節単位で確認事項 0 件だった
  const t1 = rec([0, 3, "father", "組替はしない、脱着4本。"]);
  const c1 = enumerateCandidates(t1, ledger);
  const r1 = resolveInvoice([ref(id(c1, "item", 0, "脱着"), id(c1, "qty", 0, "4本"))], c1, t1, ledger);
  assert.ok(has(r1.confirmations, "line", "否定", 0), JSON.stringify(r1.confirmations));
  for (const w of NEGATION_CUES) {
    const t2 = rec([0, 3, "father", `バランス4本${w}。`]);
    const c2 = enumerateCandidates(t2, ledger);
    const r2 = resolveInvoice([ref(id(c2, "item", 0, "バランス"), id(c2, "qty", 0, "4本"))], c2, t2, ledger);
    assert.ok(has(r2.confirmations, "line", "否定", 0), w);
  }
});

test("条件 6: 2 行が同じ候補 ID・同じ {seg,text} を指すと後の行に「同じ根拠」", () => {
  const t = rec([0, 2, "father", "脱着4本。"], [2, 4, "father", "ナット2個。"]);
  const cs = enumerateCandidates(t, ledger);
  const a = ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"));
  const r = resolveInvoice([a, structuredClone(a)], cs, t, ledger);
  assert.ok(has(r.confirmations, "line", "同じ根拠", 1), JSON.stringify(r.confirmations));
  assert.ok(!has(r.confirmations, "line", "同じ根拠", 0));

  const q = id(cs, "qty", 1, "2個");
  const r2 = resolveInvoice([ref({ seg: 1, text: "ナット" }, q), ref({ seg: 1, text: "ナット" }, null)], cs, t, ledger);
  assert.ok(has(r2.confirmations, "line", "同じ根拠", 1), JSON.stringify(r2.confirmations));
});

test("条件 7: 行の根拠が 20 秒を超えると「20 秒」", () => {
  assert.equal(MAX_LINE_SEC, 20);
  const t = rec([0, 2, "father", "脱着4本。"], [30, 32, "father", "1本550円。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"), id(cs, "unitPrice", 1, "1本550円"))], cs, t, ledger);
  assert.ok(has(r.confirmations, "line", "20 秒", 0), JSON.stringify(r.confirmations));
  assert.equal(r.lines[0].provenance.startSec, 0);
  assert.equal(r.lines[0].provenance.endSec, 32);
});

test("条件 8: {seg,text} の seg が範囲外、または語が発話に無ければ「品目の語が発話に無い」", () => {
  const t = rec([0, 2, "father", "ナット2個替える。"]);
  const cs = enumerateCandidates(t, ledger);
  const q = id(cs, "qty", 0, "2個");
  for (const item of [{ seg: 5, text: "ナット" }, { seg: -1, text: "ナット" }, { seg: 0, text: "ホイールナット" }, { seg: 0, text: "" }]) {
    const r = resolveInvoice([ref(item, q)], cs, t, ledger);
    assert.ok(has(r.confirmations, "item", "品目の語が発話に無い", 0), JSON.stringify(item));
  }
  const ok = resolveInvoice([ref({ seg: 0, text: "ナット" }, q)], cs, t, ledger);
  assert.deepEqual(ok.confirmations, []);
});

test("条件 15: 料金表の語が出たのに行が無ければ lineIndex -1 の確認事項（否定の節の語は除く）", () => {
  const t = rec([0, 2, "father", "脱着4本。"], [2, 4, "father", "バランス4本。"], [4, 6, "father", "組替はしない。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))], cs, t, ledger);
  const c15 = r.confirmations.filter((c) => c.message.includes("料金表の品目の語が出たのに行が無い"));
  assert.deepEqual(
    c15.map((c) => [c.lineIndex, c.field, c.item]),
    [[-1, "item", "ホイールバランス"]],
  );
});

test("参照が不正: 候補に無い ID・種類の違う ID はその欄を null にして確認事項", () => {
  const t = rec([0, 3, "father", "ナット2個で合計400円。"]);
  const cs = enumerateCandidates(t, ledger);
  const q = id(cs, "qty", 0, "2個");
  const total = cs.find((c) => c.kind === "total")!.id;
  const r = resolveInvoice(
    [ref({ seg: 0, text: "ナット" }, q, total), ref("i99", "q99"), ref({ seg: 0, text: "ナット" }, q, null, q)],
    cs,
    t,
    ledger,
  );
  assert.equal(r.lines[0].unitPrice, null);
  assert.equal(r.lines[0].qty, 2);
  assert.ok(has(r.confirmations, "line", "参照が不正", 0));
  assert.equal(r.lines[1].item, "");
  assert.equal(r.lines[1].qty, null);
  assert.ok(has(r.confirmations, "line", "参照が不正", 1));
  assert.ok(has(r.confirmations, "qty", "数量が分からない", 1));
  assert.ok(has(r.confirmations, "line", "参照が不正", 2));
});

// --- (5) 敵対レビューの例の移植 ---

test("指摘 1: 「脱着する。」には数量の候補が無く、数量は「数量が分からない」", () => {
  const { cs, confirmations, lines } = run([ref("i1", null)], rec([0, 2, "father", "脱着する。"]));
  assert.deepEqual(cs.filter((c) => c.kind === "qty"), []);
  assert.equal(lines[0].qty, null);
  assert.ok(has(confirmations, "qty", "数量が分からない", 0));
});

test("指摘 1: 「脱着4本。」の品目を「タイヤ組替」にすると「品目の語が発話に無い」、ID で指せば料金表の脱着", () => {
  const t = rec([0, 2, "father", "脱着4本。"]);
  const cs = enumerateCandidates(t, ledger);
  const q = id(cs, "qty", 0, "4本");
  const r = resolveInvoice([ref({ seg: 0, text: "タイヤ組替" }, q)], cs, t, ledger);
  assert.ok(has(r.confirmations, "item", "品目の語が発話に無い", 0));
  assert.equal(resolveInvoice([ref(id(cs, "item", 0, "脱着"), q)], cs, t, ledger).lines[0].item, "タイヤ脱着");
});

test("指摘 1: 「ナット2個替える。」の品目を「ホイールナット」にすると不合格、「ナット」は合格", () => {
  const t = rec([0, 2, "father", "ナット2個替える。"]);
  const cs = enumerateCandidates(t, ledger);
  const q = id(cs, "qty", 0, "2個");
  assert.ok(has(resolveInvoice([ref({ seg: 0, text: "ホイールナット" }, q)], cs, t, ledger).confirmations, "item", "品目の語が発話に無い", 0));
  assert.deepEqual(resolveInvoice([ref({ seg: 0, text: "ナット" }, q)], cs, t, ledger).confirmations, []);
});

test("指摘 1: 「1本330円」「1個は330円」の 1 は数量の候補にならず、数量は「数量が分からない」", () => {
  for (const s of ["ゴムバルブは1本330円。", "ナットは1個は330円。"]) {
    const t = rec([0, 3, "father", s]);
    const cs = enumerateCandidates(t, ledger);
    assert.deepEqual(cs.filter((c) => c.kind === "qty"), [], s);
    const p = cs.find((c) => c.kind === "unitPrice")!.id;
    const item = s.startsWith("ゴム") ? id(cs, "item", 0, "ゴムバルブ") : { seg: 0, text: "ナット" };
    const r = resolveInvoice([ref(item, null, p)], cs, t, ledger);
    assert.ok(has(r.confirmations, "qty", "数量が分からない", 0), s);
  }
});

test("指摘 1: 漢数字の数量・単価も戻せる", () => {
  const t = rec([0, 3, "father", "ゴムバルブ四本、一本三百三十円。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "ゴムバルブ"), id(cs, "qty", 0, "4本"), id(cs, "unitPrice", 0, "1本330円"))], cs, t, ledger);
  assert.deepEqual(r.confirmations, []);
  assert.equal(priceInvoice({ lines: r.lines }, ledger).total, 1320);
});

test("指摘 2: 「1個1330円」から 330 の候補は出ず、指せるのは 1330 だけ", () => {
  const t = rec([0, 3, "father", "ナット2個、1個1330円。"]);
  const cs = enumerateCandidates(t, ledger);
  assert.ok(!cs.some((c) => c.value === 330));
  const r = resolveInvoice([ref({ seg: 0, text: "ナット" }, id(cs, "qty", 0, "2個"), id(cs, "unitPrice", 0, "1個1330円"))], cs, t, ledger);
  assert.equal(r.lines[0].unitPrice, 1330);
});

test("指摘 2: 「合計400円」を単価に指すと「参照が不正」で単価は null", () => {
  const t = rec([0, 3, "father", "ナット2個で合計400円。"]);
  const cs = enumerateCandidates(t, ledger);
  const total = cs.find((c) => c.kind === "total")!;
  assert.equal(total.value, 400);
  const r = resolveInvoice([ref({ seg: 0, text: "ナット" }, id(cs, "qty", 0, "2個"), total.id)], cs, t, ledger);
  assert.equal(r.lines[0].unitPrice, null);
  assert.ok(has(r.confirmations, "line", "参照が不正", 0));
});

test("指摘 2: 1 単位あたりの形（1個／単価）は確認事項なしで、合計を出す", () => {
  const t = rec([0, 3, "father", "ナット2個、1個330円。"], [3, 6, "father", "クリップ4個、単価は1,100円。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice(
    [
      ref({ seg: 0, text: "ナット" }, id(cs, "qty", 0, "2個"), id(cs, "unitPrice", 0, "1個330円")),
      ref({ seg: 1, text: "クリップ" }, id(cs, "qty", 1, "4個"), cs.find((c) => c.kind === "unitPrice" && c.seg === 1)!.id),
    ],
    cs,
    t,
    ledger,
  );
  assert.deepEqual(r.confirmations, []);
  assert.equal(priceInvoice({ lines: r.lines }, ledger).total, 660 + 4400);
});

test("指摘 2: 「1セット1000円」を本の行の単価にすると、料金表の単価と違って確認事項になる", () => {
  const t = rec([0, 3, "father", "ゴムバルブ4本、1セット1000円。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "ゴムバルブ"), id(cs, "qty", 0, "4本"), id(cs, "unitPrice", 0, "1セット1000円"))], cs, t, ledger);
  const p = priceInvoice({ lines: r.lines }, ledger);
  assert.ok(p.confirmations.some((c) => c.field === "unitPrice"), JSON.stringify(p.confirmations));
  assert.equal(p.total, null);
});

test("指摘 3: 「1個33.0円」は 33 のまま戻り、引用は発話の文そのもの（書き換えられない）", () => {
  const t = rec([0, 3, "father", "ナット2個、1個33.0円。"]);
  const cs = enumerateCandidates(t, ledger);
  assert.ok(!cs.some((c) => c.value === 330));
  const r = resolveInvoice([ref({ seg: 0, text: "ナット" }, id(cs, "qty", 0, "2個"), id(cs, "unitPrice", 0, "1個33.0円"))], cs, t, ledger);
  assert.equal(r.lines[0].unitPrice, 33);
  assert.equal(r.lines[0].provenance.quote, "ナット2個、1個33.0円。");
});

test("指摘 4: 0–2 秒と 100–102 秒の発話をつないだ行は「20 秒」", () => {
  const t = rec([0, 2, "father", "ナット1個3"], [100, 102, "father", "30円"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref({ seg: 0, text: "ナット" }, id(cs, "qty", 0, "1個"), null, id(cs, "amount", 1, "30円"))], cs, t, ledger);
  assert.ok(has(r.confirmations, "line", "20 秒", 0));
});

test("指摘 4: 2 発話にまたがる「1個3」「30円」から 330 の候補は出ず、確認事項が出る", () => {
  const t = rec([0, 2, "father", "ナット2個、1個3"], [2, 4, "father", "30円"]);
  const cs = enumerateCandidates(t, ledger);
  assert.ok(!cs.some((c) => c.value === 330));
  const r = resolveInvoice([ref({ seg: 0, text: "ナット" }, id(cs, "qty", 0, "2個"))], cs, t, ledger);
  assert.equal(r.lines[0].unitPrice, null);
  assert.ok(r.confirmations.length > 0);
  assert.ok(has(r.confirmations, "unitPrice", "言った金額がどの行にも使われていない", -1));
});

test("指摘 5: 同じ発話を根拠にした 2 行は「同じ根拠」、料金表でも二重の行", () => {
  const t = rec([0, 2, "father", "脱着4本。"]);
  const cs = enumerateCandidates(t, ledger);
  const a = ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"));
  const r = resolveInvoice([a, ref({ seg: 0, text: "脱着" }, id(cs, "qty", 0, "4本"))], cs, t, ledger);
  assert.ok(has(r.confirmations, "line", "同じ根拠", 1));
  const p = priceInvoice({ lines: r.lines }, ledger);
  assert.equal(p.confirmations.filter((c) => c.field === "item").length, 2);
  assert.equal(p.total, null);
});

test("指摘 6: 「脱着1台。」の単位は発話の台のまま戻り（書き換えられない）、料金表の照合で確認事項", () => {
  const t = rec([0, 2, "father", "脱着1台。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "1台"))], cs, t, ledger);
  assert.deepEqual(r.confirmations, []);
  assert.equal(r.lines[0].unit, "台");
  const p = priceInvoice({ lines: r.lines }, ledger);
  assert.deepEqual(
    p.confirmations.map((c) => [c.field, c.message]),
    [["unit", "「タイヤ脱着」の単位が発話（台）と料金表（本）で違う"]],
  );
  assert.equal(p.total, null);
});

test("指摘 7: 別名が 2 つの項目に当たる語は正式名に戻さず、料金表の照合で確認事項", () => {
  const ambiguous: LedgerEntry[] = [
    ...ledger,
    { item: "バランスウェイト", aliases: ["バランス"], price: 220, unit: "個", source: "a" },
  ];
  const t = rec([0, 2, "father", "バランス4本。"]);
  const cs = enumerateCandidates(t, ambiguous);
  const r = resolveInvoice([ref(id(cs, "item", 0, "バランス"), id(cs, "qty", 0, "4本"))], cs, t, ambiguous);
  assert.equal(r.lines[0].item, "バランス");
  const p = priceInvoice({ lines: r.lines }, ambiguous);
  assert.equal(p.lines[0].ledger.found, false);
  assert.equal(p.lines[0].unitPrice, null);
  assert.ok(p.confirmations.some((c) => c.field === "item" && c.message.includes("別名があいまい")));
  assert.equal(p.total, null);
});

test("指摘 8: 客の発話を指した行の speaker は customer になる（付け替えられない）、混在は unknown", () => {
  const t = rec([0, 2, "customer", "脱着4本。"], [2, 4, "father", "1本550円。"]);
  const cs = enumerateCandidates(t, ledger);
  const item = id(cs, "item", 0, "脱着");
  const q = id(cs, "qty", 0, "4本");
  assert.equal(resolveInvoice([ref(item, q)], cs, t, ledger).lines[0].provenance.speaker, "customer");
  const mixed = resolveInvoice([ref(item, q, id(cs, "unitPrice", 1, "1本550円"))], cs, t, ledger);
  assert.equal(mixed.lines[0].provenance.speaker, "unknown");
  assert.equal(mixed.lines[0].provenance.quote, "脱着4本。1本550円。");
  const other = rec([0, 2, "mechanic-b", "脱着4本。"]);
  const oc = enumerateCandidates(other, ledger);
  assert.equal(resolveInvoice([ref("i1", "q1")], oc, other, ledger).lines[0].provenance.speaker, "unknown");
});

test("指摘 9: tire-003 に「200円」の候補は無く、無い ID を指すと「参照が不正」、料金表でも単価の確認事項", () => {
  const t = byId("tire-003");
  const cs = enumerateCandidates(t, ledger);
  assert.ok(!cs.some((c) => c.value === 200));
  const r = resolveInvoice([ref({ seg: 1, text: "ホイールナット" }, id(cs, "qty", 1, "2個", 1), "p1")], cs, t, ledger);
  assert.equal(r.lines[0].unitPrice, null);
  assert.ok(has(r.confirmations, "line", "参照が不正", 0));
  const p = priceInvoice({ lines: r.lines }, ledger);
  assert.ok(p.confirmations.some((c) => c.field === "unitPrice"));
  assert.equal(p.total, null);
});

// --- 規則 A〜C（2026-11-04 の Codex の 7 例と追加の 4 例） ---

/** 3 秒ずつの発話の架空の録音（話者は父）。 */
const seq = (...texts: string[]) => rec(...texts.map((x, i): [number, number, string, string] => [i * 3, i * 3 + 3, "father", x]));

test("規則 C: 「脱着4本は、やらない。」「脱着4本は不要。」は「否定」", () => {
  for (const s of ["脱着4本は、やらない。", "脱着4本は不要。", "バランス4本、やらない"]) {
    const t = seq(s);
    const cs = enumerateCandidates(t, ledger);
    const r = resolveInvoice([ref("i1", "q1")], cs, t, ledger);
    assert.ok(has(r.confirmations, "line", "否定", 0), `${s} ${JSON.stringify(r.confirmations)}`);
  }
});

test("規則 C: 否定の文の単価を指した行も「否定」（「バランスは1本550円だけどやらない。脱着4本。」）", () => {
  const t = seq("バランスは1本550円だけどやらない。脱着4本。");
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"), id(cs, "unitPrice", 0, "1本550円"))], cs, t, ledger);
  assert.equal(r.lines[0].unitPrice, 550);
  assert.ok(has(r.confirmations, "line", "否定", 0), JSON.stringify(r.confirmations));
  // 単価を指さなければ、別の文の否定は脱着の行に効かない（使われない単価は条件 2）
  const r2 = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))], cs, t, ledger);
  assert.ok(!has(r2.confirmations, "line", "否定"), JSON.stringify(r2.confirmations));
  assert.ok(has(r2.confirmations, "unitPrice", "言った金額がどの行にも使われていない", -1));
});

test("規則 C: 単価だけを指した否定の文の行も「否定」（「バランスは1本1100円、やらない」）", () => {
  const t = seq("バランスは1本1100円、やらない");
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "バランス"), null, id(cs, "unitPrice", 0, "1本1100円"))], cs, t, ledger);
  assert.ok(has(r.confirmations, "line", "否定", 0), JSON.stringify(r.confirmations));
});

test("規則 C: 方言の否定（まいね・わがね・いらね・やらね・しね）も合図", () => {
  for (const w of ["まいね", "わがね", "いらね", "やらね", "しね", "やめ", "見送り"]) {
    assert.ok(NEGATION_CUES.includes(w), w);
    const t = seq(`脱着4本は${w}。`);
    const cs = enumerateCandidates(t, ledger);
    assert.ok(has(resolveInvoice([ref("i1", "q1")], cs, t, ledger).confirmations, "line", "否定", 0), w);
  }
});

test("規則 B: 「脱着4本、いや2。」の使われない 2 は確認事項", () => {
  const t = seq("脱着4本、いや2。");
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref("i1", "q1")], cs, t, ledger);
  assert.ok(has(r.confirmations, "qty", "言い直し", 0), JSON.stringify(r.confirmations));
  assert.deepEqual(r.unused.map((c) => [c.kind, c.text]), [["bareNumber", "2"]]);
});

test("規則 B: 別の発話（3 秒後）の「いや2本」・別の単位の「いや2個」も確認事項", () => {
  for (const texts of [["脱着4本。", "いや2本。"], ["バランス4本", "いや2本"], ["バランス4本、いや2個"]]) {
    const t = seq(...texts);
    const cs = enumerateCandidates(t, ledger);
    const r = resolveInvoice([ref("i1", "q1")], cs, t, ledger);
    assert.ok(has(r.confirmations, "qty", "言い直し", 0), `${texts.join("/")} ${JSON.stringify(r.confirmations)}`);
  }
});

test("規則 B: 行から 20 秒より遠い使われない数量・数は確認事項にせず unused だけ", () => {
  const t = rec([0, 2, "father", "脱着4本。"], [23, 25, "father", "車は2台ある。"], [40, 42, "father", "あと3"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref("i1", "q1")], cs, t, ledger);
  assert.deepEqual(r.confirmations, []);
  assert.deepEqual(r.unused.map((c) => [c.kind, c.text]), [["qty", "2台"], ["bareNumber", "3"]]);
  // ちょうど 20 秒の隔たり（2 秒→22 秒）は近い
  const t20 = rec([0, 2, "father", "脱着4本。"], [22, 24, "father", "いや2本。"]);
  const c20 = enumerateCandidates(t20, ledger);
  assert.ok(has(resolveInvoice([ref("i1", "q1")], c20, t20, ledger).confirmations, "qty", "言い直し", 0));
});

test("規則 B: 遠くても言った金額は今のとおり確認事項（条件 2 を弱めない）", () => {
  const t = rec([0, 2, "father", "脱着4本。"], [60, 62, "father", "1本550円。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref("i1", "q1")], cs, t, ledger);
  assert.ok(has(r.confirmations, "unitPrice", "言った金額がどの行にも使われていない", -1), JSON.stringify(r.confirmations));
});

test("規則 A: 「脱着二二十4本。」は数量が無く、q1 を指すと「参照が不正」、読めない数は距離によらず確認事項", () => {
  const t = seq("脱着二二十4本。");
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref("i1", "q1")], cs, t, ledger);
  assert.equal(r.lines[0].qty, null);
  assert.ok(has(r.confirmations, "line", "参照が不正", 0));
  assert.ok(has(r.confirmations, "qty", "数が読めない", -1), JSON.stringify(r.confirmations));
  const none = resolveInvoice([], cs, t, ledger);
  assert.ok(has(none.confirmations, "qty", "数が読めない", -1));
});

test("規則 A: 「ゴムバルブ4本で3,1320円。」は金額が無く、読めない円は確認事項", () => {
  const t = seq("ゴムバルブ4本で3,1320円。");
  const cs = enumerateCandidates(t, ledger);
  assert.ok(!cs.some((c) => c.value === 1320));
  const r = resolveInvoice([ref("i1", "q1", null, "a1")], cs, t, ledger);
  assert.ok(has(r.confirmations, "line", "参照が不正", 0));
  assert.ok(has(r.confirmations, "unitPrice", "円の前の数が読めない", -1), JSON.stringify(r.confirmations));
});

test("条件 16: 数量と「1＋単位」の単価の単位が違えば「単位が数量と単価で違う」", () => {
  const t = seq("ゴムバルブ4本、1セット330円。");
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "ゴムバルブ"), id(cs, "qty", 0, "4本"), id(cs, "unitPrice", 0, "1セット330円"))], cs, t, ledger);
  assert.ok(has(r.confirmations, "unit", "単位が数量と単価で違う", 0), JSON.stringify(r.confirmations));
  // 同じ単位・単価に単位が無いときは出ない
  for (const s of ["ゴムバルブ4本、1本330円。", "ゴムバルブ4本、単価は330円。"]) {
    const t2 = seq(s);
    const c2 = enumerateCandidates(t2, ledger);
    const r2 = resolveInvoice([ref("i1", "q1", "p1")], c2, t2, ledger);
    assert.ok(!has(r2.confirmations, "unit", "単位が数量と単価で違う"), s);
  }
});

// --- (6) 入力を書き換えない ---

test("D4: 「脱着.4本。」は数量を出さず、読めない数として確認事項（4本 と推測しない）", () => {
  const t = rec([0, 2, "father", "脱着.4本。"]);
  const cs = enumerateCandidates(t, ledger);
  assert.ok(!cs.some((c) => c.kind === "qty"), JSON.stringify(cs));
  const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), null)], cs, t, ledger);
  assert.ok(has(r.confirmations, "qty", "数が読めない", -1), JSON.stringify(r.confirmations));
  assert.ok(has(r.confirmations, "qty", "数量が分からない", 0));
});

test("数量の小数: 本・個・台・輪・枚・つ・箇所・回 の数量が整数でなければ確認事項、セット・式は今のまま", () => {
  for (const u of ["本", "個", "台", "輪", "枚", "つ", "箇所", "回"]) {
    const t = rec([0, 2, "father", `脱着0.4${u}。`]);
    const cs = enumerateCandidates(t, ledger);
    const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, `0.4${u}`))], cs, t, ledger);
    assert.ok(has(r.confirmations, "qty", "整数でない", 0), `${u} ${JSON.stringify(r.confirmations)}`);
  }
  for (const u of ["セット", "式"]) {
    const t = rec([0, 2, "father", `脱着0.5${u}。`]);
    const cs = enumerateCandidates(t, ledger);
    const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, `0.5${u}`))], cs, t, ledger);
    assert.ok(!has(r.confirmations, "qty", "整数でない"), `${u} ${JSON.stringify(r.confirmations)}`);
  }
  // 対照: 「4.0本」は整数として読む
  const t = rec([0, 2, "father", "脱着4.0本。"]);
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4.0本"))], cs, t, ledger);
  assert.deepEqual(r.confirmations, []);
});

test("呼び出しの前後で参照・候補・文字起こし・料金表が変わらない", () => {
  const t = byId("tire-002");
  const cs = enumerateCandidates(t, ledger);
  const refs = [
    ref(id(cs, "item", 1, "ゴムバルブ"), id(cs, "qty", 1, "4本", 1), id(cs, "unitPrice", 2, "1本330円")),
    ref({ seg: 0, text: "組替" }, "q99", null, null),
  ];
  const before = structuredClone([refs, cs, t, ledger]);
  const r = resolveInvoice(refs, cs, t, ledger);
  r.lines[0].provenance.quote = "書き換え";
  r.unused.forEach((c) => (c.text = "書き換え"));
  assert.deepEqual([refs, cs, t, ledger], before);
});

// --- 条件 6 の例外: 1 つの数量を複数の行が使う（通しの確認の不具合 3） ---

test("条件 6: 「タイヤ4本、組替とバランスだ。」の 4本 を組替とバランスが使うのは許す", () => {
  const t = rec([0, 4, "father", "タイヤ4本、組替とバランスだ。"]);
  const cs = enumerateCandidates(t, ledger);
  const q = id(cs, "qty", 0, "4本");
  const r = resolveInvoice([ref(id(cs, "item", 0, "組替"), q), ref(id(cs, "item", 0, "バランス"), q)], cs, t, ledger);
  assert.deepEqual(r.confirmations, []);
  assert.deepEqual(r.lines.map((l) => [l.item, l.qty, l.unit]), [["タイヤ組替", 4, "本"], ["ホイールバランス", 4, "本"]]);
  // 料金表に無い品目の語（{seg,text}）でも同じ
  const t2 = rec([0, 4, "father", "4本、組替とナット交換だ。"]);
  const cs2 = enumerateCandidates(t2, ledger);
  const q2 = id(cs2, "qty", 0, "4本");
  const r2 = resolveInvoice([ref(id(cs2, "item", 0, "組替"), q2), ref({ seg: 0, text: "ナット交換" }, q2)], cs2, t2, ledger);
  assert.ok(!has(r2.confirmations, "line", "同じ根拠"), JSON.stringify(r2.confirmations));
});

test("条件 6: 品目の語が数量と別の文にあれば、共有の数量は「同じ根拠」", () => {
  const t = rec([0, 4, "father", "タイヤ4本、組替だ。バランスも。"]);
  const cs = enumerateCandidates(t, ledger);
  const q = id(cs, "qty", 0, "4本");
  const r = resolveInvoice([ref(id(cs, "item", 0, "組替"), q), ref(id(cs, "item", 0, "バランス"), q)], cs, t, ledger);
  assert.ok(has(r.confirmations, "line", "同じ根拠", 1), JSON.stringify(r.confirmations));
  // 別の発話の品目も同じ
  const t2 = rec([0, 3, "father", "タイヤ4本、組替だ。"], [3, 5, "father", "バランスも。"]);
  const cs2 = enumerateCandidates(t2, ledger);
  const q2 = id(cs2, "qty", 0, "4本");
  const r2 = resolveInvoice([ref(id(cs2, "item", 0, "組替"), q2), ref(id(cs2, "item", 1, "バランス"), q2)], cs2, t2, ledger);
  assert.ok(has(r2.confirmations, "line", "同じ根拠", 1), JSON.stringify(r2.confirmations));
});

test("条件 6: 文にもう 1 つ数量があれば、共有の数量は「同じ根拠」", () => {
  for (const text of ["タイヤ4本、組替とバランスと、バルブ2本だ。", "組替4本、バランスと2だ。"]) {
    const t = rec([0, 4, "father", text]);
    const cs = enumerateCandidates(t, ledger);
    const q = id(cs, "qty", 0, "4本");
    const r = resolveInvoice([ref(id(cs, "item", 0, "組替"), q), ref(id(cs, "item", 0, "バランス"), q)], cs, t, ledger);
    assert.ok(has(r.confirmations, "line", "同じ根拠", 1), `${text} ${JSON.stringify(r.confirmations)}`);
  }
});

test("条件 6: 単価・金額の共有と、同じ品目の語を 2 回指した共有の数量は今のまま「同じ根拠」", () => {
  const t = rec([0, 4, "father", "組替とバランス、1本500円。"]);
  const cs = enumerateCandidates(t, ledger);
  const p = id(cs, "unitPrice", 0, "1本500円");
  const r = resolveInvoice([ref(id(cs, "item", 0, "組替"), null, p), ref(id(cs, "item", 0, "バランス"), null, p)], cs, t, ledger);
  assert.ok(has(r.confirmations, "line", "同じ根拠", 1));
  const t2 = rec([0, 4, "father", "タイヤ4本、組替と2200円だ。"]);
  const cs2 = enumerateCandidates(t2, ledger);
  const a = id(cs2, "amount", 0, "2200円");
  const r2 = resolveInvoice([ref(id(cs2, "item", 0, "組替"), null, null, a), ref({ seg: 0, text: "タイヤ" }, null, null, a)], cs2, t2, ledger);
  assert.ok(has(r2.confirmations, "line", "同じ根拠", 1));
  // 同じ語を候補と {seg,text} で指す
  const t3 = rec([0, 2, "father", "組替4本だ。"]);
  const cs3 = enumerateCandidates(t3, ledger);
  const q3 = id(cs3, "qty", 0, "4本");
  const r3 = resolveInvoice([ref(id(cs3, "item", 0, "組替"), q3), ref({ seg: 0, text: "組替" }, q3)], cs3, t3, ledger);
  assert.ok(has(r3.confirmations, "line", "同じ根拠", 1));
});

test("条件 6: 共有の数量の文に、つなぎと決まった語のほかが残れば、共有した行すべてを確認事項（数量）にする", () => {
  const cases: [string, string, string][] = [
    ["組替4本、バランスは前だけ。", "組替", "バランス"],
    ["組替4本、バランスは片側だけだ。", "組替", "バランス"],
    ["タイヤ4本、組替とバランスは後ろだけ。", "組替", "バランス"],
  ];
  for (const [text, a, b] of cases) {
    const t = rec([0, 4, "father", text]);
    const cs = enumerateCandidates(t, ledger);
    const q = id(cs, "qty", 0, "4本");
    const r = resolveInvoice([ref(id(cs, "item", 0, a), q), ref(id(cs, "item", 0, b), q)], cs, t, ledger);
    assert.ok(has(r.confirmations, "qty", "同じ根拠", 0), `${text} ${JSON.stringify(r.confirmations)}`);
    assert.ok(has(r.confirmations, "qty", "同じ根拠", 1), `${text} ${JSON.stringify(r.confirmations)}`);
    assert.equal(priceInvoice({ lines: r.lines }, ledger).confirmations.length, 0, "料金表では止まらない形");
  }
  // つなぎと決まった語だけなら今のまま通る
  for (const text of ["タイヤ4本、組替とバランスだ。", "タイヤ4本、組替とバランスも替えた。", "4本、組替とバランスやった。"]) {
    const t = rec([0, 4, "father", text]);
    const cs = enumerateCandidates(t, ledger);
    const q = id(cs, "qty", 0, "4本");
    const r = resolveInvoice([ref(id(cs, "item", 0, "組替"), q), ref(id(cs, "item", 0, "バランス"), q)], cs, t, ledger);
    assert.deepEqual(r.confirmations, [], text);
  }
});
