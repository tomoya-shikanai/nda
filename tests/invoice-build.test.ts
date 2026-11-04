/**
 * 明細を発話で確かめてから料金表で照らす通し（buildInvoice）と、後検証の抜け道の試験。Claude は呼ばない。
 * 「指摘 N」は敵対レビュー（2026-11-04）の入力の例をそのまま使った。発話は架空で、証明には使わない。
 * 架空の録音（recordingId "adv"）は試験の中で作る。fixture の録音は tire-transcripts.json。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { buildInvoice } from "../lib/invoice/build";
import { priceInvoice } from "../lib/invoice/price";
import type { InvoiceDraft, InvoiceLine } from "../lib/invoice/schema";
import { MAX_QUOTE_SEC, normalizeNumbers, verifyInvoice } from "../lib/invoice/verify";
import { type LedgerEntry, lookup } from "../lib/ledger/lookup";
import type { Segment, Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8"),
) as LedgerEntry[];
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

const line = (
  item: string,
  qty: number | null,
  unit: string | null,
  unitPrice: number | null,
  startSec: number,
  endSec: number,
  quote: string,
  opts: { recordingId?: string; speaker?: InvoiceLine["provenance"]["speaker"] } = {},
): InvoiceLine => ({
  item,
  qty,
  unit,
  unitPrice,
  provenance: {
    recordingId: opts.recordingId ?? "adv",
    startSec,
    endSec,
    speaker: opts.speaker ?? "father",
    quote,
  },
});

const draft = (...lines: InvoiceLine[]): InvoiceDraft => ({ lines });

/** 後検証で落ち、通しでは確認事項（line）になって合計を出さない。 */
function assertRejected(d: InvoiceDraft, t: Transcript, pattern: RegExp, l: LedgerEntry[] = ledger) {
  assert.match(verifyInvoice(d, t, l).join("\n"), pattern);
  const r = buildInvoice(d, t, l);
  assert.ok(
    r.confirmations.some((c) => c.field === "line" && pattern.test(c.message)),
    JSON.stringify(r.confirmations),
  );
  assert.equal(r.total, null);
  return r;
}

// --- 指摘 1: 発話に無い数量・品目 ---

test("指摘 1: 「脱着する。」に数量 4 を付けた行は「数量が発話に無い」で合計を出さない", () => {
  const t = rec([0, 2, "father", "脱着する。"]);
  const r = assertRejected(draft(line("タイヤ脱着", 4, "本", null, 0, 2, "脱着する。")), t, /数量が発話に無い/);
  assert.equal(r.lines[0].amount, null);
});

test("指摘 1: 「脱着4本。」に品目「タイヤ組替」を付けた行は「品目が発話に無い」で合計を出さない", () => {
  const t = rec([0, 2, "father", "脱着4本。"]);
  assertRejected(draft(line("タイヤ組替", 4, "本", null, 0, 2, "脱着4本。")), t, /品目が発話に無い/);
});

test("指摘 1: 料金表に無い品目は、品目名そのものが引用に無ければ不合格", () => {
  const t = rec([0, 2, "father", "ナット2個替える。"]);
  assertRejected(draft(line("ホイールナット", 2, "個", null, 0, 2, "ナット2個替える。")), t, /品目が発話に無い/);
  assert.deepEqual(verifyInvoice(draft(line("ナット", 2, "個", null, 0, 2, "ナット2個替える。")), t, ledger), []);
});

test("指摘 1: 単価の「1本330円」の「1本」は数量にしない", () => {
  const t = rec([0, 3, "father", "ゴムバルブは1本330円。"]);
  assertRejected(draft(line("エアバルブ交換", 1, "本", 330, 0, 3, "ゴムバルブは1本330円。")), t, /数量が発話に無い/);
});

test("指摘 1: 漢数字の数量・単価も照らせる", () => {
  const t = rec([0, 3, "father", "ゴムバルブ四本、一本三百三十円。"]);
  const d = draft(line("エアバルブ交換", 4, "本", 330, 0, 3, "ゴムバルブ四本、一本三百三十円。"));
  assert.deepEqual(verifyInvoice(d, t, ledger), []);
  assert.equal(buildInvoice(d, t, ledger).total, 1320);
});

// --- 指摘 2: 金額の部分一致・合計額の転用 ---

test("指摘 2: 「1個1330円」の中の「330円」を単価にした行は不合格", () => {
  const t = rec([0, 3, "father", "ナット2個、1個1330円。"]);
  assertRejected(draft(line("ナット", 2, "個", 330, 0, 3, "ナット2個、1個1330円。")), t, /単価が発話に無い/);
});

test("指摘 2: 「合計400円」を単価にした行は「単価の根拠が発話に無い」で不合格", () => {
  const t = rec([0, 3, "father", "ナット2個で合計400円。"]);
  assertRejected(draft(line("ナット", 2, "個", 400, 0, 3, "ナット2個で合計400円。")), t, /単価の根拠が発話に無い/);
});

test("指摘 2: 1 単位あたりの形（1個／単価）で言った値段は合格し、合計を出す", () => {
  const t = rec([0, 3, "father", "ナット2個、1個330円。"], [3, 6, "father", "クリップ4個、単価は1,100円。"]);
  const d = draft(
    line("ナット", 2, "個", 330, 0, 3, "ナット2個、1個330円。"),
    line("クリップ", 4, "個", 1100, 3, 6, "クリップ4個、単価は1,100円。"),
  );
  assert.deepEqual(verifyInvoice(d, t, ledger), []);
  assert.equal(buildInvoice(d, t, ledger).total, 660 + 4400);
});

test("指摘 2: 単価の単位が明細の単位と違う（「1セット1000円」を 1 本あたりにする）行は不合格", () => {
  const t = rec([0, 3, "father", "ゴムバルブ4本、1セット1000円。"]);
  const d = draft(line("ゴムバルブ", 4, "本", 1000, 0, 3, "ゴムバルブ4本、1セット1000円。"));
  assertRejected(d, t, /単価の根拠が発話に無い/, []);
});

test("指摘 1: 「1本は330円」の「1本」も数量にしない", () => {
  const t = rec([0, 3, "father", "ナットは1個は330円。"]);
  assert.match(verifyInvoice(draft(line("ナット", 1, "個", 330, 0, 3, "ナットは1個は330円。")), t, ledger).join(), /数量が発話に無い/);
});

// --- 指摘 3: 小数点を消す正規化 ---

test("指摘 3: 発話「1個33.0円」を引用で「1個330円」に変えた行は不合格", () => {
  const t = rec([0, 3, "father", "ナット2個、1個33.0円。"]);
  assertRejected(draft(line("ナット", 2, "個", 330, 0, 3, "ナット2個、1個330円。")), t, /単価の根拠が発話に無い/);
});

test("指摘 3: 数量・単価の正規化は小数点を残し、数字の間のカンマだけ外す", () => {
  assert.equal(normalizeNumbers("1個33.0円。"), "1個33.0円。");
  assert.equal(normalizeNumbers("単価は1,330円、2、3本"), "単価は1330円、2、3本");
  assert.equal(normalizeNumbers("二十四本、１本　３３０円"), "24本、1本330円");
});

// --- 指摘 4: 離れた発話の連結 ---

test("指摘 4: 0–2 秒「ナット1個3」と 100–102 秒「30円」をつないだ引用は不合格", () => {
  const t = rec([0, 2, "father", "ナット1個3"], [100, 102, "father", "30円"]);
  assertRejected(draft(line("ナット", 1, "個", 330, 0, 102, "ナット1個330円")), t, /時間の幅が長すぎる/);
  assert.equal(MAX_QUOTE_SEC, 20);
});

test("指摘 4: 幅の上限の内でも、2 つの発話にまたがる数・金額は 1 つの発話の中に無ければ不合格", () => {
  const t = rec([0, 2, "father", "ナット2個、1個3"], [2, 4, "father", "30円"]);
  assertRejected(draft(line("ナット", 2, "個", 330, 0, 4, "ナット2個、1個330円")), t, /単価の根拠が発話に無い/);
});

test("指摘 4: 2 発話にまたがる引用そのものは、数と金額がそれぞれ 1 つの発話の中にあれば合格（tire-002 のバルブ）", () => {
  const t = byId("tire-002");
  const d = draft(
    line("エアバルブ交換", 4, "本", 330, 6, 13, "ゴムバルブも4本替える。ゴムバルブは1本330円。", { recordingId: "tire-002" }),
  );
  assert.deepEqual(verifyInvoice(d, t, ledger), []);
});

// --- 指摘 5: 二重の行 ---

test("指摘 5: 同じ発話を根拠にした「タイヤ脱着」2 行は確認事項になり、合計を出さない", () => {
  const t = rec([0, 2, "father", "脱着4本。"]);
  const l = line("タイヤ脱着", 4, "本", null, 0, 2, "脱着4本。");
  const r = buildInvoice(draft(l, structuredClone(l)), t, ledger);
  assert.deepEqual(
    r.confirmations.map((c) => [c.lineIndex, c.field]),
    [
      [0, "item"],
      [1, "item"],
    ],
  );
  assert.equal(r.total, null);
});

test("指摘 5: 正式名と別名で書いた同じ品目も二重の行とみなす", () => {
  const r = priceInvoice(
    draft(line("タイヤ脱着", 4, "本", null, 0, 2, "脱着4本。"), line("脱着", 4, "本", null, 0, 2, "脱着4本。")),
    ledger,
  );
  assert.equal(r.confirmations.filter((c) => c.field === "item").length, 2);
  assert.equal(r.total, null);
});

// --- 指摘 6: 単位の上書き ---

test("指摘 6: 「脱着1台。」は料金表の単位（本）と違うので、単価を null にして確認事項にする", () => {
  const t = rec([0, 2, "father", "脱着1台。"]);
  const r = buildInvoice(draft(line("タイヤ脱着", 1, "台", null, 0, 2, "脱着1台。")), t, ledger);
  assert.deepEqual(
    r.confirmations.map((c) => [c.field, c.message]),
    [["unit", "「タイヤ脱着」の単位が発話（台）と料金表（本）で違う"]],
  );
  assert.equal(r.lines[0].unitPrice, null);
  assert.equal(r.lines[0].unit, "台");
  assert.equal(r.lines[0].amount, null);
  assert.equal(r.total, null);
});

test("指摘 6: 「脱着1台。」の行の単位を「本」と書き換えても、発話の単位と違うので不合格", () => {
  const t = rec([0, 2, "father", "脱着1台。"]);
  assertRejected(draft(line("タイヤ脱着", 1, "本", null, 0, 2, "脱着1台。")), t, /数量の単位が発話（台）と明細（本）で違う/);
});

// --- 指摘 7: 料金表の照合 ---

const collided: LedgerEntry[] = [
  { item: "タイヤ組替", aliases: ["タイヤ脱着"], price: 1650, unit: "本", source: "a" },
  ...ledger,
];

test("指摘 7: 先頭の別名「タイヤ脱着」より、後ろの正式名「タイヤ脱着」を優先する", () => {
  const t = rec([0, 2, "father", "タイヤ脱着4本。"]);
  const r = buildInvoice(draft(line("タイヤ脱着", 4, "本", null, 0, 2, "タイヤ脱着4本。")), t, collided);
  assert.equal(r.lines[0].ledger.price, 550);
  assert.deepEqual(r.confirmations, []);
  assert.equal(r.total, 2200);
});

test("指摘 7: 別名が 2 つ以上の項目に当たるときは推測で選ばず found:false", () => {
  const ambiguous: LedgerEntry[] = [
    ...ledger,
    { item: "バランスウェイト", aliases: ["バランス"], price: 220, unit: "個", source: "a" },
  ];
  assert.deepEqual(lookup(ambiguous, "バランス"), {
    item: "バランス",
    found: false,
    price: null,
    unit: null,
    source: null,
  });
  assert.equal(lookup(ambiguous, "ホイールバランス").price, 1100);
  const twins: LedgerEntry[] = [...ledger, { ...ledger[1], price: 600 }];
  assert.equal(lookup(twins, "タイヤ脱着").found, false);
});

// --- 指摘 8: 話者の付け替え ---

test("指摘 8: 客（customer）の発話「脱着4本。」を father の言葉にした行は不合格", () => {
  const t = rec([0, 2, "customer", "脱着4本。"]);
  assertRejected(draft(line("タイヤ脱着", 4, "本", null, 0, 2, "脱着4本。")), t, /話者が発話（customer）と違う/);
  const ok = draft(line("タイヤ脱着", 4, "本", null, 0, 2, "脱着4本。", { speaker: "customer" }));
  assert.deepEqual(verifyInvoice(ok, t, ledger), []);
});

test("指摘 8: 隣の発話の話者は見ない（引用を作った発話だけ）", () => {
  const t = rec([0, 2, "father", "脱着4本。"], [2, 4, "customer", "お願いします。"]);
  assert.deepEqual(verifyInvoice(draft(line("タイヤ脱着", 4, "本", null, 0, 2, "脱着4本。")), t, ledger), []);
});

// --- 指摘 9: fixture に無い発話を根拠にした単価 ---

test("指摘 9: tire-003 で「ナット1個200円」を根拠にした単価は、発話に無いので確認事項になる", () => {
  const t = byId("tire-003");
  const d = draft(
    line("ホイールナット", 2, "個", 200, 5, 10, "ナット1個200円", { recordingId: "tire-003", speaker: "unknown" }),
  );
  const r = buildInvoice(d, t, ledger);
  assert.ok(r.confirmations.some((c) => c.field === "line" && /文字起こしに無い/.test(c.message)));
  assert.equal(r.lines[0].amount, null);
  assert.equal(r.total, null);
});

// --- 指摘 10 相当: 通し ---

test("通し: fixture の 3 件は、発話に合う明細なら料金表どおりの合計（tire-003 はナットの単価を確かめる）", () => {
  const f = (id: string) => ({ recordingId: id });
  const u = { recordingId: "tire-003", speaker: "unknown" as const };
  const r1 = buildInvoice(
    draft(
      line("タイヤ脱着", 4, "本", null, 0, 5, "冬タイヤさ履き替えるはんで、脱着4本な。", f("tire-001")),
      line("ホイールバランス", 4, "本", null, 5, 9, "バランスも4本取っておぐ。", f("tire-001")),
    ),
    byId("tire-001"),
    ledger,
  );
  assert.deepEqual(r1.confirmations, []);
  assert.equal(r1.total, 6600);

  const r2 = buildInvoice(
    draft(
      line("組替", 4, "本", null, 0, 6, "組替4本", f("tire-002")),
      line("バランス", 4, "本", null, 6, 10, "バランス4本", f("tire-002")),
      line("ゴムバルブ", 4, "本", 330, 6, 13, "ゴムバルブも4本替える。ゴムバルブは1本330円。", f("tire-002")),
      line("廃タイヤ", 4, "本", null, 13, 17, "廃タイヤ4本。", f("tire-002")),
    ),
    byId("tire-002"),
    ledger,
  );
  assert.deepEqual(r2.confirmations, []);
  assert.equal(r2.total, 13640);

  const r3 = buildInvoice(
    draft(
      line("タイヤ脱着", 4, "本", null, 0, 5, "スタッドレスさ履き替え、脱着4本。", u),
      line("ホイールナット", 2, "個", null, 5, 10, "ホイールナットも2個替える。", u),
    ),
    byId("tire-003"),
    ledger,
  );
  assert.deepEqual(
    r3.confirmations.map((c) => [c.lineIndex, c.field]),
    [[1, "unitPrice"]],
  );
  assert.equal(r3.lines[0].amount, 2200);
  assert.equal(r3.total, null);
});

test("通し: 入力の明細・文字起こし・料金表を書き換えない", () => {
  const t = rec([0, 2, "father", "脱着4本。"]);
  const d = draft(line("タイヤ脱着", 4, "本", null, 0, 2, "脱着する。"));
  const before = [structuredClone(d), structuredClone(t), structuredClone(ledger)];
  const r = buildInvoice(d, t, ledger);
  r.lines[0].provenance.quote = "書き換え";
  assert.deepEqual([d, t, ledger], before);
});
