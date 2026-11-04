/**
 * 通し（assembleInvoice・buildInvoice）と、金額の検算・言った合計の照合（checkAmounts）、別名があいまいな品目の検証。
 * Claude は偽サーバーで置き換える。モデルの品質は検証しない。
 * 素材は架空の文字起こし（tire-transcripts.json）と、この試験の中で作る架空の録音（recordingId "adv"）。証明には使わない。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { assembleInvoice, buildInvoice } from "../lib/invoice/build";
import { type Candidate, enumerateCandidates } from "../lib/invoice/candidates";
import { checkAmounts } from "../lib/invoice/check";
import { priceInvoice } from "../lib/invoice/price";
import type { InvoiceRefs, LineRef } from "../lib/invoice/schema";
import { type LedgerEntry, findEntry, isAmbiguous, lookup } from "../lib/ledger/lookup";
import type { Transcript } from "../lib/stt/types";

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

const has = (cf: { field: string; message: string; lineIndex: number }[], field: string, word: string, lineIndex?: number) =>
  cf.some((c) => c.field === field && c.message.includes(word) && (lineIndex === undefined || c.lineIndex === lineIndex));

/** 料金表の「バランス」が 2 つの項目に当たるようにした架空の料金表。 */
const ambiguous: LedgerEntry[] = [
  ...ledger,
  { item: "バランスウェイト", aliases: ["バランス"], price: 220, unit: "本", source: "架空（試験用）" },
];

// --- (1) 別名があいまい ---

test("isAmbiguous: 2 つの項目に当たる別名だけ true、正式名で 1 つに決まる・どこにも当たらないなら false", () => {
  assert.equal(isAmbiguous(ambiguous, "バランス"), true);
  assert.equal(isAmbiguous(ambiguous, "ホイールバランス"), false);
  assert.equal(isAmbiguous(ambiguous, "ナット"), false);
  assert.equal(isAmbiguous(ledger, "バランス"), false);
  assert.equal(isAmbiguous(ambiguous, ""), false);
  // findEntry・lookup の振る舞いは変わらない
  assert.equal(findEntry(ambiguous, "バランス"), null);
  assert.equal(lookup(ambiguous, "バランス").found, false);
});

test("(1) 別名があいまいな「バランス」に発話の単価 500 円を付けた行は unitPrice null・「別名があいまい」・total null", () => {
  const t = seq("バランス4本、1本500円。");
  const cs = enumerateCandidates(t, ambiguous);
  const r = assembleInvoice(
    {
      candidates: cs,
      lines: [ref(id(cs, "item", 0, "バランス"), id(cs, "qty", 0, "4本"), { unitPrice: id(cs, "unitPrice", 0, "1本500円") })],
      negations: [],
    },
    t,
    ambiguous,
  );
  assert.equal(r.lines[0].unitPrice, null);
  assert.equal(r.lines[0].amount, null);
  assert.ok(has(r.confirmations, "item", "別名があいまい", 0), JSON.stringify(r.confirmations));
  assert.equal(r.total, null);
  // 発話の単価が無くても、あいまいなら「別名があいまい」
  const p = priceInvoice({ lines: [{ ...r.lines[0], unitPrice: null }] }, ambiguous);
  assert.ok(has(p.confirmations, "item", "別名があいまい", 0));
});

test("(1) 料金表に無い品目に発話の単価がある行は、今のまま発話の単価を使う", () => {
  const t = seq("ナット2個、1個200円。");
  const cs = enumerateCandidates(t, ledger);
  const r = assembleInvoice(
    {
      candidates: cs,
      lines: [ref({ seg: 0, text: "ナット" }, id(cs, "qty", 0, "2個"), { unitPrice: id(cs, "unitPrice", 0, "1個200円") })],
      negations: [],
    },
    t,
    ledger,
  );
  assert.deepEqual(r.confirmations, []);
  assert.equal(r.lines[0].unitPrice, 200);
  assert.equal(r.lines[0].amount, 400);
  assert.equal(r.total, 400);
});

// --- (2) 条件 13 ---

const amountCase = (text: string) => {
  const t = seq(text);
  const cs = enumerateCandidates(t, ledger);
  const x = {
    candidates: cs,
    lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"), { amount: cs.find((c) => c.kind === "amount")?.id ?? null })],
    negations: [],
  };
  return { cs, x, r: assembleInvoice(x, t, ledger) };
};

test("(2) 条件 13:「脱着4本で2200円。」は確認事項 0 件、「脱着4本で2000円。」は「金額が合わない」", () => {
  const ok = amountCase("脱着4本で2200円。");
  assert.ok(ok.x.lines[0].amount !== null);
  assert.deepEqual(ok.r.confirmations, []);
  assert.equal(ok.r.total, 2200);
  assert.deepEqual(ok.r.unused, []);

  const ng = amountCase("脱着4本で2000円。");
  assert.ok(has(ng.r.confirmations, "unitPrice", "金額が合わない", 0), JSON.stringify(ng.r.confirmations));
  assert.equal(ng.r.lines[0].amount, null);
  assert.equal(ng.r.total, null);
});

test("条件 13: amount の impliedQty が行の数量と違えば「金額が合わない」、単価か数量が無ければ検算しない", () => {
  // 「脱着2本で2200円」の行に別の 4本 を付けると、積が合っていても数量が違う
  const t = seq("脱着4本。", "いえ、脱着2本で2200円。");
  const cs = enumerateCandidates(t, ledger);
  const amount = id(cs, "amount", 1, "2200円");
  const priced = priceInvoice({ lines: [{ item: "タイヤ脱着", qty: 4, unit: "本", unitPrice: 550, provenance: { recordingId: "adv", startSec: 0, endSec: 6, speaker: "father", quote: "" } }] }, ledger);
  const refs = [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"), { amount })];
  assert.ok(has(checkAmounts(priced, refs, cs), "unitPrice", "金額が合わない", 0));
  // 数量が無い行は検算しない（金額から数量・単価を割り出さない）
  const noQty = priceInvoice({ lines: [{ ...priced.lines[0], qty: null }] }, ledger);
  assert.deepEqual(checkAmounts(noQty, refs, cs).filter((c) => c.message.includes("金額が合わない")), []);
  assert.equal(noQty.lines[0].amount, null);
});

// --- (3) 条件 14 ---

const totalCase = (tail: string) => {
  const t = seq("脱着4本、バランス4本。", tail);
  const cs = enumerateCandidates(t, ledger);
  const x = {
    candidates: cs,
    lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref(id(cs, "item", 0, "バランス"), id(cs, "qty", 0, "4本", 1))],
    negations: [],
  };
  return assembleInvoice(x, t, ledger);
};

test("(3) 条件 14: 合計6600円は確認事項 0 件で total 6600、6000円は「言った合計と計算が違う」、税込みは「照らせない」", () => {
  const ok = totalCase("合計6600円。");
  assert.deepEqual(ok.confirmations, []);
  assert.equal(ok.total, 6600);

  const ng = totalCase("合計6000円。");
  assert.ok(has(ng.confirmations, "unitPrice", "言った合計と計算が違う", -1), JSON.stringify(ng.confirmations));
  assert.equal(ng.total, null);
  // 行の金額は消さない（確認事項は行に付かない）
  assert.deepEqual(ng.lines.map((l) => l.amount), [2200, 4400]);

  const tax = totalCase("税込みで7260円。");
  assert.ok(has(tax.confirmations, "unitPrice", "税込みの合計は照らせない", -1), JSON.stringify(tax.confirmations));
  assert.equal(tax.total, null);
});

test("条件 14: 他の確認事項があれば合計は照らさない、税込みの合計は他の確認事項があっても確認事項にする", () => {
  const t = seq("脱着4本、バランス。", "合計6000円。");
  const cs = enumerateCandidates(t, ledger);
  const r = assembleInvoice(
    { candidates: cs, lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref(id(cs, "item", 0, "バランス"), null)], negations: [] },
    t,
    ledger,
  );
  assert.ok(has(r.confirmations, "qty", "数量が分からない", 1));
  assert.ok(!r.confirmations.some((c) => c.message.includes("言った合計")), JSON.stringify(r.confirmations));
  assert.equal(r.total, null);

  const t2 = seq("脱着4本、バランス。", "税込みで7260円。");
  const c2 = enumerateCandidates(t2, ledger);
  const r2 = assembleInvoice(
    { candidates: c2, lines: [ref(id(c2, "item", 0, "脱着"), id(c2, "qty", 0, "4本")), ref(id(c2, "item", 0, "バランス"), null)], negations: [] },
    t2,
    ledger,
  );
  assert.ok(has(r2.confirmations, "unitPrice", "税込みの合計は照らせない", -1));
});

test("通し: 確認事項は lineIndex 順、確認事項の付いた行は amount null", () => {
  const t = seq("脱着4本で2000円、バランス4本。", "合計6600円。");
  const cs = enumerateCandidates(t, ledger);
  const r = assembleInvoice(
    {
      candidates: cs,
      lines: [
        ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"), { amount: id(cs, "amount", 0, "2000円") }),
        ref(id(cs, "item", 0, "バランス"), id(cs, "qty", 0, "4本", 1), { status: "unsure" }),
      ],
      negations: [],
    },
    t,
    ledger,
  );
  const idx = r.confirmations.map((c) => c.lineIndex);
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  assert.ok(has(r.confirmations, "unitPrice", "金額が合わない", 0));
  assert.ok(has(r.confirmations, "line", "確かでない", 1));
  assert.deepEqual(r.lines.map((l) => l.amount), [null, null]);
  assert.equal(r.total, null);
});

// --- (4) buildInvoice（偽サーバー） ---

/** 3 fixture の正しい参照（tire-003 のホイールナットも done にする）。 */
function goodRefs(t: Transcript, cs: Candidate[]): InvoiceRefs {
  switch (t.recordingId) {
    case "tire-001":
      return {
        lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref(id(cs, "item", 1, "バランス"), id(cs, "qty", 1, "4本"))],
        negations: [],
      };
    case "tire-002":
      return {
        lines: [
          ref(id(cs, "item", 0, "組替"), id(cs, "qty", 0, "4本")),
          ref(id(cs, "item", 1, "バランス"), id(cs, "qty", 1, "4本", 0)),
          ref(id(cs, "item", 1, "ゴムバルブ"), id(cs, "qty", 1, "4本", 1), { unitPrice: id(cs, "unitPrice", 2, "1本330円") }),
          ref(id(cs, "item", 3, "廃タイヤ"), id(cs, "qty", 3, "4本")),
        ],
        negations: [],
      };
    default:
      return {
        lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref({ seg: 1, text: "ホイールナット" }, id(cs, "qty", 1, "2個", 1))],
        negations: [],
      };
  }
}

let server: Server;
let reply: unknown = null;

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg",
          type: "message",
          role: "assistant",
          model: "fake",
          content: [{ type: "text", text: JSON.stringify(reply) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${addr.port}`;
});
after(() => server.close());

test("(4) buildInvoice: tire-001・tire-002 は確認事項 0 件で total 6600・13640", async () => {
  for (const [rid, total] of [["tire-001", 6600], ["tire-002", 13640]] as const) {
    const t = byId(rid);
    reply = goodRefs(t, enumerateCandidates(t, ledger));
    const r = await buildInvoice(t, ledger);
    assert.deepEqual(r.confirmations, [], rid);
    assert.equal(r.total, total, rid);
  }
});

test("(4) buildInvoice: tire-003 はホイールナットの単価の確認事項で total null", async () => {
  const t = byId("tire-003");
  reply = goodRefs(t, enumerateCandidates(t, ledger));
  const r = await buildInvoice(t, ledger);
  assert.ok(has(r.confirmations, "unitPrice", "ホイールナット", 1), JSON.stringify(r.confirmations));
  assert.equal(r.lines[1].unitPrice, null);
  assert.equal(r.total, null);
});

test("(4) buildInvoice: 偽サーバーが negated の行を返せば total null", async () => {
  const t = byId("tire-001");
  const cs = enumerateCandidates(t, ledger);
  const good = goodRefs(t, cs);
  reply = { ...good, lines: [good.lines[0], { ...good.lines[1], status: "negated", evidence: [good.lines[1].qty] }] };
  const r = await buildInvoice(t, ledger);
  assert.ok(has(r.confirmations, "line", "否定", 1), JSON.stringify(r.confirmations));
  assert.equal(r.lines[1].amount, null);
  assert.equal(r.total, null);
});

// --- (5) 入力を書き換えない ---

test("(5) assembleInvoice の前後で入力が変わらない", () => {
  for (const t of [...transcripts, seq("脱着4本で2000円、バランス4本。", "合計6000円。")]) {
    const cs = enumerateCandidates(t, ledger);
    const x =
      t.recordingId === "adv"
        ? { candidates: cs, lines: [ref("i1", "q1", { amount: "a1" }), ref("i2", "q2")], negations: [{ seg: 1, text: "合計6000円。" }] }
        : { candidates: cs, ...goodRefs(t, cs) };
    const before = structuredClone([x, t, ledger]);
    const r = assembleInvoice(x, t, ledger);
    assert.deepEqual([x, t, ledger], before, t.recordingId);
    r.lines[0].provenance.quote = "書き換え";
    r.unused.forEach((c) => (c.text = "書き換え"));
    assert.deepEqual([x, t, ledger], before, t.recordingId);
  }
});
