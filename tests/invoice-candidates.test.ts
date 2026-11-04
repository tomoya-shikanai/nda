/**
 * 発話から候補を列挙する部分（enumerateCandidates）の検証。Claude は呼ばない。
 * 素材は架空の文字起こし（tire-transcripts.json）と、この試験の中で作る架空の録音。証明には使わない。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { type Candidate, enumerateCandidates, normalizeText } from "../lib/invoice/candidates";
import type { LedgerEntry } from "../lib/ledger/lookup";
import type { Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8")) as LedgerEntry[];
const transcripts = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/tire-transcripts.json"), "utf8"),
) as Transcript[];
const tire002 = transcripts.find((t) => t.recordingId === "tire-002")!;

/** 架空の録音。発話 1 つずつに文を入れる。 */
const fake = (...texts: string[]): Transcript => ({
  recordingId: "fake-cand",
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: texts.map((text, i) => ({ startSec: i * 5, endSec: i * 5 + 5, speaker: "father", text })),
});

const ofKind = (cs: Candidate[], kind: Candidate["kind"]) => cs.filter((c) => c.kind === kind);

test("tire-002: 数量・単価・品目の候補が出る", () => {
  const cs = enumerateCandidates(tire002, ledger);
  const qty = ofKind(cs, "qty");
  assert.deepEqual(
    qty.map((c) => [c.seg, c.text, c.value, c.unit]),
    [
      [0, "4本", 4, "本"], // 組替
      [1, "4本", 4, "本"], // バランス
      [1, "4本", 4, "本"], // ゴムバルブ
      [3, "4本", 4, "本"], // 廃タイヤ
    ],
  );
  const prices = ofKind(cs, "unitPrice");
  assert.equal(prices.length, 1);
  assert.equal(prices[0].text, "1本330円");
  assert.equal(prices[0].value, 330);
  assert.equal(prices[0].unit, "本");
  assert.equal(prices[0].seg, 2);
  const items = ofKind(cs, "item").map((c) => c.ledgerItem);
  for (const name of ["タイヤ組替", "ホイールバランス", "エアバルブ交換", "廃タイヤ処分"]) {
    assert.ok(items.includes(name), `${name} の item 候補が無い`);
  }
  // text は正規化後の発話のその範囲
  for (const c of cs) {
    assert.equal(normalizeText(tire002.segments[c.seg].text).slice(c.start, c.end), c.text);
  }
});

test("「ゴムバルブは1本330円」で qty 候補が出ない", () => {
  const cs = enumerateCandidates(fake("ゴムバルブは1本330円"), ledger);
  assert.deepEqual(ofKind(cs, "qty"), []);
  assert.equal(ofKind(cs, "unitPrice").length, 1);
});

test("「脱着2-4本」で qty 候補が出ない", () => {
  for (const s of ["脱着2-4本", "脱着2〜4本", "脱着2~4本"]) {
    assert.deepEqual(ofKind(enumerateCandidates(fake(s), ledger), "qty"), [], s);
  }
});

test("「1個二二十円」は無視されず unparsedYen になる", () => {
  const cs = enumerateCandidates(fake("1個二二十円"), ledger);
  const u = ofKind(cs, "unparsedYen");
  assert.equal(u.length, 1);
  assert.equal(u[0].text, "二二十円");
  assert.equal(u[0].value, null);
  assert.deepEqual(ofKind(cs, "unitPrice"), []);
  assert.deepEqual(ofKind(cs, "amount"), []);
  assert.equal(normalizeText("二二十"), "二二十");
});

test("「合計8800円、税込みで9680円」で total が 2 件", () => {
  const cs = enumerateCandidates(fake("合計8800円、税込みで9680円"), ledger);
  const totals = ofKind(cs, "total");
  assert.deepEqual(
    totals.map((c) => [c.value, c.taxIncluded]),
    [
      [8800, false],
      [9680, true],
    ],
  );
  assert.deepEqual(ofKind(cs, "amount"), []);
});

test("「1個33.0円」で単価は 33.0 のまま（330 にならない）", () => {
  const p = ofKind(enumerateCandidates(fake("1個33.0円"), ledger), "unitPrice");
  assert.equal(p.length, 1);
  assert.equal(p[0].value, 33.0);
  assert.notEqual(p[0].value, 330);
  assert.equal(p[0].text, "1個33.0円");
});

test("「三百三十円」「三三〇円」は 330 として読む。「1,000円」は 1 つの数", () => {
  for (const s of ["三百三十円", "三三〇円"]) {
    const a = ofKind(enumerateCandidates(fake(s), ledger), "amount");
    assert.deepEqual(a.map((c) => c.value), [330], s);
  }
  assert.deepEqual(ofKind(enumerateCandidates(fake("1,000円"), ledger), "amount").map((c) => c.value), [1000]);
});

test("「4個で880円」で amount 880（impliedQty 4、unit 個）と qty 4個", () => {
  const cs = enumerateCandidates(fake("4個で880円"), ledger);
  const a = ofKind(cs, "amount");
  assert.equal(a.length, 1);
  assert.equal(a[0].value, 880);
  assert.equal(a[0].impliedQty, 4);
  assert.equal(a[0].unit, "個");
  assert.deepEqual(ofKind(cs, "qty").map((c) => [c.text, c.value, c.unit]), [["4個", 4, "個"]]);
});

test("ID は kind ごとに 1 からの連番で (seg, start) の順、2 回呼んで同じ", () => {
  const t = fake("組替4本、バランス4本。", "ゴムバルブは1本330円、4本で1320円。", "合計8800円、税込みで9680円。二二十円");
  const a = enumerateCandidates(t, ledger);
  const b = enumerateCandidates(t, ledger);
  assert.deepEqual(a, b);
  const prefix = { qty: "q", unitPrice: "p", total: "t", amount: "a", unparsedYen: "u", item: "i" } as const;
  for (const kind of Object.keys(prefix) as Candidate["kind"][]) {
    const cs = ofKind(a, kind);
    assert.ok(cs.length > 0, `${kind} が無い`);
    assert.deepEqual(cs.map((c) => c.id), cs.map((_, i) => `${prefix[kind]}${i + 1}`));
    for (let i = 1; i < cs.length; i++) {
      assert.ok(cs[i - 1].seg < cs[i].seg || (cs[i - 1].seg === cs[i].seg && cs[i - 1].start < cs[i].start));
    }
  }
  assert.equal(new Set(a.map((c) => c.id)).size, a.length);
});

test("呼び出しの前後で文字起こしと料金表が変わらない", () => {
  const t = structuredClone(tire002);
  const l = structuredClone(ledger);
  enumerateCandidates(t, l);
  assert.deepEqual(t, tire002);
  assert.deepEqual(l, ledger);
});
