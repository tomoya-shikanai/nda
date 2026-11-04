/**
 * 請求の明細の通し（設計 docs/design/invoice-verify.md）: 候補 → 抽出 → 参照を値に戻す → 料金表 → 金額と合計の照合。
 * 確認事項が 1 件でもあれば total は null。確認事項の付いた行は金額を出さない。入力は書き換えない。
 */
import type { LedgerEntry } from "../ledger/lookup";
import type { Transcript } from "../stt/types";
import type { Candidate } from "./candidates";
import { checkAmounts } from "./check";
import { extractInvoice } from "./extract";
import { type Confirmation, type PricedInvoice, priceInvoice } from "./price";
import { resolveInvoice } from "./resolve";
import type { InvoiceRefs } from "./schema";

export type AssembledInvoice = PricedInvoice & { unused: Candidate[] };

/**
 * 確認事項を合わせて lineIndex の順に並べる。同じ行の同じ確認事項（field と文言が同じ。resolve と price の
 * 「数量が分からない」など）は 1 件にし、関係する候補は合わせる。確認事項の種類は減らさない。
 */
export function mergeConfirmations(...lists: Confirmation[][]): Confirmation[] {
  const out: Confirmation[] = [];
  for (const c of lists.flat()) {
    const i = out.findIndex((o) => o.lineIndex === c.lineIndex && o.field === c.field && o.message === c.message);
    if (i < 0) {
      out.push(c);
      continue;
    }
    const ids = [...new Set([...(out[i].candidates ?? []), ...(c.candidates ?? [])])];
    out[i] = ids.length ? { ...out[i], candidates: ids } : out[i];
  }
  return out.sort((a, b) => a.lineIndex - b.lineIndex);
}

/** 候補と参照から明細を組み立てる。純粋な関数（API を呼ばない）。 */
export function assembleInvoice(
  x: { candidates: Candidate[] } & InvoiceRefs,
  t: Transcript,
  ledger: LedgerEntry[],
): AssembledInvoice {
  const resolved = resolveInvoice(x.lines, x.candidates, t, ledger, x.negations);
  const priced = priceInvoice({ lines: resolved.lines }, ledger);
  const before = mergeConfirmations(resolved.confirmations, priced.confirmations);
  const flagged = (cf: { lineIndex: number }[], i: number) => cf.some((c) => c.lineIndex === i);
  const lines = priced.lines.map((l, i) => (flagged(before, i) ? { ...l, amount: null } : l));
  const checked = checkAmounts({ lines, confirmations: before, total: before.length ? null : priced.total }, x.lines, x.candidates);
  const confirmations = mergeConfirmations(before, checked);
  const final = lines.map((l, i) => (l.amount !== null && flagged(checked, i) ? { ...l, amount: null } : l));
  const total = confirmations.length === 0 ? final.reduce((s, l) => s + (l.amount ?? 0), 0) : null;
  return { lines: final, confirmations, total, unused: resolved.unused };
}

/** 文字起こしから明細を作る（Claude を 1 回呼ぶ）。 */
export async function buildInvoice(t: Transcript, ledger: LedgerEntry[]): Promise<AssembledInvoice> {
  return assembleInvoice(await extractInvoice(t, ledger), t, ledger);
}
