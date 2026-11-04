/**
 * 請求の明細の通し（設計 docs/design/invoice-verify.md）: 候補 → 抽出 → 参照を値に戻す → 料金表 → 金額と合計の照合。
 * 確認事項が 1 件でもあれば total は null。確認事項の付いた行は金額を出さない。入力は書き換えない。
 */
import type { LedgerEntry } from "../ledger/lookup";
import type { Transcript } from "../stt/types";
import type { Candidate } from "./candidates";
import { checkAmounts } from "./check";
import { extractInvoice } from "./extract";
import { type PricedInvoice, priceInvoice } from "./price";
import { resolveInvoice } from "./resolve";
import type { InvoiceRefs } from "./schema";

export type AssembledInvoice = PricedInvoice & { unused: Candidate[] };

/** 候補と参照から明細を組み立てる。純粋な関数（API を呼ばない）。 */
export function assembleInvoice(
  x: { candidates: Candidate[] } & InvoiceRefs,
  t: Transcript,
  ledger: LedgerEntry[],
): AssembledInvoice {
  const resolved = resolveInvoice(x.lines, x.candidates, t, ledger, x.negations);
  const priced = priceInvoice({ lines: resolved.lines }, ledger);
  const byLine = (a: { lineIndex: number }, b: { lineIndex: number }) => a.lineIndex - b.lineIndex;
  const before = [...resolved.confirmations, ...priced.confirmations].sort(byLine);
  const flagged = (cf: { lineIndex: number }[], i: number) => cf.some((c) => c.lineIndex === i);
  const lines = priced.lines.map((l, i) => (flagged(before, i) ? { ...l, amount: null } : l));
  const checked = checkAmounts({ lines, confirmations: before, total: before.length ? null : priced.total }, x.lines, x.candidates);
  const confirmations = [...before, ...checked].sort(byLine);
  const final = lines.map((l, i) => (l.amount !== null && flagged(checked, i) ? { ...l, amount: null } : l));
  const total = confirmations.length === 0 ? final.reduce((s, l) => s + (l.amount ?? 0), 0) : null;
  return { lines: final, confirmations, total, unused: resolved.unused };
}

/** 文字起こしから明細を作る（Claude を 1 回呼ぶ）。 */
export async function buildInvoice(t: Transcript, ledger: LedgerEntry[]): Promise<AssembledInvoice> {
  return assembleInvoice(await extractInvoice(t, ledger), t, ledger);
}
