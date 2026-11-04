/**
 * 明細を料金表で照らす部分の検証。Claude は呼ばない。
 * 明細は架空の文字起こし（tire-transcripts.json）に合わせて手で書いた。素材は架空で、証明には使わない。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { priceInvoice } from "../lib/invoice/price";
import type { InvoiceDraft, InvoiceLine } from "../lib/invoice/schema";
import type { LedgerEntry } from "../lib/ledger/lookup";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8"),
) as LedgerEntry[];

const line = (
  recordingId: string,
  item: string,
  qty: number | null,
  unit: string | null,
  unitPrice: number | null,
  startSec: number,
  endSec: number,
  quote: string,
): InvoiceLine => ({
  item,
  qty,
  unit,
  unitPrice,
  provenance: { recordingId, startSec, endSec, speaker: "father", quote },
});

const tire002 = (): InvoiceDraft => ({
  lines: [
    line("tire-002", "組替", 4, "本", null, 0, 6, "組替4本"),
    line("tire-002", "バランス", 4, "本", null, 6, 10, "バランス4本"),
    line("tire-002", "ゴムバルブ", 4, "本", 330, 10, 13, "ゴムバルブは1本330円"),
    line("tire-002", "廃タイヤ", 4, "本", null, 13, 17, "廃タイヤ4本"),
  ],
});

const tire003 = (): InvoiceDraft => ({
  lines: [
    line("tire-003", "脱着", 4, "本", null, 0, 5, "脱着4本"),
    line("tire-003", "ホイールナット", 2, "個", null, 5, 10, "ホイールナットも2個替える"),
  ],
});

test("tire-002: 全行が料金表にあり、確認事項 0 件、合計 13640", () => {
  const r = priceInvoice(tire002(), ledger);
  assert.equal(r.lines.length, 4);
  assert.ok(r.lines.every((l) => l.ledger.found));
  assert.deepEqual(r.confirmations, []);
  assert.equal(r.total, 13640);
  assert.deepEqual(
    r.lines.map((l) => l.amount),
    [6600, 4400, 1320, 1320],
  );
});

test("tire-003: 料金表に無いホイールナットは推測で埋めず、合計を出さない", () => {
  const r = priceInvoice(tire003(), ledger);
  const nut = r.lines[1];
  assert.deepEqual(nut.ledger, {
    item: "ホイールナット",
    found: false,
    price: null,
    unit: null,
    source: null,
  });
  assert.equal(nut.unitPrice, null);
  assert.equal(nut.amount, null);
  assert.ok(
    r.confirmations.some(
      (c) => c.lineIndex === 1 && c.field === "unitPrice" && c.message.includes("ホイールナット"),
    ),
  );
  assert.equal(r.total, null);

  const datchaku = r.lines[0];
  assert.equal(datchaku.ledger.found, true);
  assert.equal(datchaku.amount, 2200);
});

test("数量が null の行は qty の確認事項になり、合計を出さない", () => {
  const d: InvoiceDraft = {
    lines: [line("tire-001", "脱着", 4, "本", null, 0, 5, "脱着4本"), line("tire-001", "バランス", null, null, null, 5, 9, "バランスも")],
  };
  const r = priceInvoice(d, ledger);
  assert.equal(r.lines[1].amount, null);
  assert.equal(r.lines[1].unitPrice, 1100);
  assert.equal(r.lines[1].unit, "本");
  assert.deepEqual(
    r.confirmations.map((c) => [c.lineIndex, c.field]),
    [[1, "qty"]],
  );
  assert.ok(r.confirmations[0].message.includes("バランス"));
  assert.equal(r.total, null);
});

test("発話の単価が料金表と違う行は単価を null にして確認事項にする", () => {
  const d: InvoiceDraft = {
    lines: [line("tire-002", "ゴムバルブ", 4, "本", 300, 10, 13, "ゴムバルブは1本300円")],
  };
  const r = priceInvoice(d, ledger);
  assert.equal(r.lines[0].unitPrice, null);
  assert.equal(r.lines[0].amount, null);
  assert.equal(r.confirmations.length, 1);
  assert.equal(r.confirmations[0].field, "unitPrice");
  assert.ok(r.confirmations[0].message.includes("300"));
  assert.ok(r.confirmations[0].message.includes("330"));
  assert.equal(r.total, null);
});

test("料金表に無くても発話に単価があればそれを使う", () => {
  const d: InvoiceDraft = {
    lines: [line("tire-003", "ホイールナット", 2, "個", 200, 5, 10, "ナット1個200円")],
  };
  const r = priceInvoice(d, ledger);
  assert.equal(r.lines[0].ledger.found, false);
  assert.equal(r.lines[0].unitPrice, 200);
  assert.equal(r.lines[0].unit, "個");
  assert.deepEqual(r.confirmations, []);
  assert.equal(r.total, 400);
});

test("呼び出しの前後で入力の明細と料金表が変わらない", () => {
  for (const d of [tire002(), tire003()]) {
    const before = structuredClone(d);
    const ledgerBefore = structuredClone(ledger);
    const r = priceInvoice(d, ledger);
    r.lines[0].provenance.quote = "書き換え";
    r.lines[0].ledger.item = "書き換え";
    assert.deepEqual(d, before);
    assert.deepEqual(ledger, ledgerBefore);
  }
});
