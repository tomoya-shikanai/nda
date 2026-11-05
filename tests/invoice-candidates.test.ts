/**
 * 発話から候補を列挙する部分（enumerateCandidates）の検証。Claude は呼ばない。
 * 素材は架空の文字起こし（tire-transcripts.json）と、この試験の中で作る架空の録音。証明には使わない。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { type Candidate, enumerateCandidates, normalizeText } from "../lib/invoice/candidates";
import { ledgerEntries, parseLedgerBook } from "../lib/ledger/lookup";
import type { Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = ledgerEntries(parseLedgerBook(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8"))));
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
  const t = fake(
    "組替4本、バランス4本。いや3。",
    "ゴムバルブは1本330円、4本で1320円。二二十4本。",
    "合計8800円、税込みで9680円。二二十円。2と5",
  );
  const a = enumerateCandidates(t, ledger);
  const b = enumerateCandidates(t, ledger);
  assert.deepEqual(a, b);
  const prefix = {
    qty: "q", unitPrice: "p", total: "t", amount: "a", unparsedYen: "u", unparsedNumber: "x", bareNumber: "n", item: "i",
  } as const;
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

// --- 規則 A: 数は「最大の数字の並び」単位で読む ---

test("規則 A: 算用数字まじりの位取りを並び全体で読む（「1万2000円」「2千500円」「合計1万3640円」）", () => {
  assert.deepEqual(ofKind(enumerateCandidates(fake("1万2000円"), ledger), "amount").map((c) => [c.text, c.value]), [["12000円", 12000]]);
  assert.deepEqual(ofKind(enumerateCandidates(fake("2千500円"), ledger), "amount").map((c) => [c.text, c.value]), [["2500円", 2500]]);
  const cs = enumerateCandidates(fake("合計1万3640円"), ledger);
  assert.deepEqual(ofKind(cs, "total").map((c) => [c.value, c.taxIncluded]), [[13640, false]]);
  assert.deepEqual(ofKind(cs, "amount"), []);
  // 並びの末尾だけ（2000・500・3640）を拾わない
  for (const s of ["1万2000円", "2千500円", "合計1万3640円"]) {
    const vs = enumerateCandidates(fake(s), ledger).map((c) => c.value);
    for (const v of [2000, 500, 3640]) assert.ok(!vs.includes(v), `${s} から ${v}`);
  }
  assert.equal(normalizeText("一万二千"), "12000");
  assert.equal(normalizeText("1万2000"), "12000");
});

test("規則 A: 読めない並びに円が続けば unparsedYen（「二二十円」「3,1320円」）、途中や末尾を数にしない", () => {
  for (const [s, text] of [["二二十円", "二二十円"], ["3,1320円", "3,1320円"], ["ゴムバルブ4本で3,1320円。", "3,1320円"]]) {
    const cs = enumerateCandidates(fake(s), ledger);
    assert.deepEqual(ofKind(cs, "unparsedYen").map((c) => [c.text, c.value]), [[text, null]], s);
    assert.deepEqual(ofKind(cs, "amount"), [], s);
    assert.deepEqual(ofKind(cs, "unitPrice"), [], s);
    for (const v of [1320, 20, 10, 3]) assert.ok(!cs.some((c) => c.value === v && c.kind !== "qty"), `${s} から ${v}`);
  }
});

test("規則 A: 「脱着二二十4本」は数量を出さず unparsedNumber", () => {
  const cs = enumerateCandidates(fake("脱着二二十4本。"), ledger);
  assert.deepEqual(ofKind(cs, "qty"), []);
  const x = ofKind(cs, "unparsedNumber");
  assert.deepEqual(x.map((c) => [c.id, c.text, c.value, c.unit]), [["x1", "二二十4本", null, "本"]]);
  assert.ok(!cs.some((c) => c.value === 4));
});

test("規則 A: 「12,000円」は 12000、「33.0円」は 33.0 のまま", () => {
  assert.deepEqual(ofKind(enumerateCandidates(fake("12,000円"), ledger), "amount").map((c) => c.value), [12000]);
  assert.deepEqual(ofKind(enumerateCandidates(fake("33.0円"), ledger), "amount").map((c) => [c.text, c.value]), [["33.0円", 33.0]]);
});

test("規則 A: 単位の付かない数（「いや2」の 2）は bareNumber、ID は n1 から", () => {
  const cs = enumerateCandidates(fake("脱着4本、いや2。"), ledger);
  assert.deepEqual(ofKind(cs, "qty").map((c) => [c.id, c.text]), [["q1", "4本"]]);
  assert.deepEqual(ofKind(cs, "bareNumber").map((c) => [c.id, c.text, c.value, c.unit]), [["n1", "2", 2, null]]);
  // 範囲（「2-4本」）の数も数量にせず bareNumber
  assert.deepEqual(ofKind(enumerateCandidates(fake("脱着2-4本"), ledger), "bareNumber").map((c) => c.value), [2, 4]);
  // 円・数量・「1本」の 1 に使った数は bareNumber にしない
  assert.deepEqual(ofKind(enumerateCandidates(fake("ゴムバルブ4本、1本330円。"), ledger), "bareNumber"), []);
});

test("D4: 小数点の片側が欠けた並び（「.4本」「4.本」「.4円」「4.円」）は数にせず、読めない数・読めない円", () => {
  const kinds = (x: string) => enumerateCandidates(fake(x), ledger).filter((c) => c.kind !== "item").map((c) => [c.kind, c.text, c.value]);
  assert.deepEqual(kinds("脱着.4本。"), [["unparsedNumber", ".4本", null]]);
  assert.deepEqual(kinds("脱着4.本。"), [["unparsedNumber", "4.本", null]]);
  assert.deepEqual(kinds("脱着4本で.2200円。"), [["qty", "4本", 4], ["unparsedYen", ".2200円", null]]);
  assert.deepEqual(kinds("脱着4本で2200.円。"), [["qty", "4本", 4], ["unparsedYen", "2200.円", null]]);
  // 対照: 数字に挟まれた小数点は今のまま 1 つの数
  assert.deepEqual(kinds("脱着0.4本。"), [["qty", "0.4本", 0.4]]);
  assert.deepEqual(kinds("1個33.0円。"), [["unitPrice", "1個33.0円", 33]]);
});

test("呼び出しの前後で文字起こしと料金表が変わらない", () => {
  const t = structuredClone(tire002);
  const l = structuredClone(ledger);
  enumerateCandidates(t, l);
  assert.deepEqual(t, tire002);
  assert.deepEqual(l, ledger);
});
