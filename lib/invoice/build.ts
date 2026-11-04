import type { LedgerEntry } from "../ledger/lookup";
import type { Transcript } from "../stt/types";
import { type PricedInvoice, priceInvoice } from "./price";
import type { InvoiceDraft } from "./schema";
import { verifyLine } from "./verify";

/**
 * 明細を発話で確かめてから料金表で照らす（通し）。
 * 後検証で不合格の行は、その理由を確認事項（field: "line"）にし、金額を計算しない。
 * 確認事項が 1 件でもあれば total は null。入力は書き換えない。
 */
export function buildInvoice(d: InvoiceDraft, t: Transcript, ledger: LedgerEntry[]): PricedInvoice {
  const priced = priceInvoice(d, ledger);
  const confirmations = [...priced.confirmations];
  const lines = priced.lines.map((line, lineIndex) => {
    const failures = verifyLine(d.lines[lineIndex], t, ledger);
    if (failures.length === 0) return line;
    for (const message of failures) {
      confirmations.push({ lineIndex, item: line.item, field: "line", message });
    }
    return { ...line, amount: null };
  });
  confirmations.sort((a, b) => a.lineIndex - b.lineIndex);
  const total =
    confirmations.length === 0 ? lines.reduce((sum, l) => sum + (l.amount ?? 0), 0) : null;
  return { lines, confirmations, total };
}
