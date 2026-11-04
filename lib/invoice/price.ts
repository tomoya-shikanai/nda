import type { LedgerResult } from "../karte/schema";
import { type LedgerEntry, findEntry, itemKey, lookup } from "../ledger/lookup";
import type { InvoiceDraft, InvoiceLine } from "./schema";

/** 料金表で照らした明細 1 行。unitPrice と unit は照合後の値。 */
export type PricedLine = InvoiceLine & {
  ledger: LedgerResult;
  amount: number | null;
};

/** 父に確かめる事項。分からない値は推測で埋めず、ここに出す。 */
export type Confirmation = {
  lineIndex: number;
  item: string;
  /** line は、行そのものが発話で確かめられない（buildInvoice の後検証で不合格）。 */
  field: "unitPrice" | "qty" | "unit" | "item" | "line";
  message: string;
};

export type PricedInvoice = {
  lines: PricedLine[];
  confirmations: Confirmation[];
  /** 確認事項が 1 件でもあれば null（途中の合計を出さない）。 */
  total: number | null;
};

/**
 * 明細を料金表で照らす。台帳に無い品目は found:false のまま（別名の推測・あいまい一致はしない）。
 * 単価が決まらない・発話と料金表が食い違う・数量が無い・単位が違う・同じ品目が 2 行ある場合は
 * 確認事項にする。入力は書き換えない。発話との突き合わせはしない（buildInvoice が行う）。
 */
export function priceInvoice(d: InvoiceDraft, ledger: LedgerEntry[]): PricedInvoice {
  const confirmations: Confirmation[] = [];
  const lines: PricedLine[] = d.lines.map((line, lineIndex) => {
    const hit = lookup(ledger, line.item);
    // 発話の単位で数えた数量を、料金表の単位の数量として扱わない
    const unitDiffers = hit.found && line.unit !== null && line.unit !== hit.unit;
    let unitPrice: number | null;
    if (unitDiffers) {
      unitPrice = null;
      confirmations.push({
        lineIndex,
        item: line.item,
        field: "unit",
        message: `「${line.item}」の単位が発話（${line.unit}）と料金表（${hit.unit}）で違う`,
      });
    } else if (hit.found) {
      if (line.unitPrice === null || line.unitPrice === hit.price) {
        unitPrice = hit.price;
      } else {
        unitPrice = null;
        confirmations.push({
          lineIndex,
          item: line.item,
          field: "unitPrice",
          message: `「${line.item}」の単価が発話（${line.unitPrice} 円）と料金表（${hit.price} 円）で違う`,
        });
      }
    } else if (line.unitPrice !== null) {
      unitPrice = line.unitPrice;
    } else {
      unitPrice = null;
      confirmations.push({
        lineIndex,
        item: line.item,
        field: "unitPrice",
        message: `「${line.item}」の単価が料金表に無い`,
      });
    }
    if (line.qty === null) {
      confirmations.push({
        lineIndex,
        item: line.item,
        field: "qty",
        message: `「${line.item}」の数量が分からない`,
      });
    }
    const amount = unitPrice !== null && line.qty !== null ? unitPrice * line.qty : null;
    return {
      ...line,
      provenance: { ...line.provenance },
      unit: hit.found && !unitDiffers ? hit.unit : line.unit,
      unitPrice,
      ledger: hit,
      amount,
    };
  });

  // 同じ品目（料金表の正式名にそろえる）の行が 2 つ以上あれば、二重の請求として確かめる
  const keys = d.lines.map((l) => itemKey(findEntry(ledger, l.item)?.item ?? l.item));
  keys.forEach((key, lineIndex) => {
    const n = keys.filter((k) => k === key).length;
    if (n < 2) return;
    const item = d.lines[lineIndex].item;
    confirmations.push({
      lineIndex,
      item,
      field: "item",
      message: `「${item}」の行が ${n} つある（同じ作業を二重に請求していないか）`,
    });
  });
  confirmations.sort((a, b) => a.lineIndex - b.lineIndex);

  const total =
    confirmations.length === 0 ? lines.reduce((sum, l) => sum + (l.amount ?? 0), 0) : null;
  return { lines, confirmations, total };
}
