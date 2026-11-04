/**
 * 金額の検算と、言った合計の照合（設計 docs/design/invoice-verify.md の (d)・条件 13・14）。
 * 純粋な関数。API を呼ばない、入力を書き換えない。金額から単価を割り出さない。言った合計を黙って捨てない。
 */
import type { Candidate } from "./candidates";
import type { Confirmation, PricedInvoice } from "./price";
import type { LineRef } from "./schema";

/**
 * priced は料金表で照らした後の明細（確認事項は、前の段で出たものを全部含めて渡す）。
 * refs[i] は priced.lines[i] の参照。返すのは、この段で新しく出た確認事項だけ。
 */
export function checkAmounts(priced: PricedInvoice, refs: LineRef[], candidates: Candidate[]): Confirmation[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: Confirmation[] = [];

  // 条件 13: 数量 × 単価 ≠ 言った金額。単価か数量が無ければ検算しない
  priced.lines.forEach((line, lineIndex) => {
    const id = refs[lineIndex]?.amount ?? null;
    if (id === null) return;
    const c = byId.get(id);
    if (!c || c.kind !== "amount" || c.value === null) return;
    if (line.qty === null || line.unitPrice === null) return;
    const product = line.qty * line.unitPrice;
    const qtyDiffers = c.impliedQty !== undefined && c.impliedQty !== line.qty;
    if (product !== c.value || qtyDiffers) {
      out.push({
        lineIndex,
        item: line.item,
        field: "unitPrice",
        message: `「${line.item}」の ${c.text} は数量 ${line.qty} × 単価 ${line.unitPrice} 円 = ${product} 円と合わない（金額が合わない）`,
      });
    }
  });

  // 条件 14: 言った合計 ≠ 計算した合計。行の確認事項（前の段のものと条件 13）があれば照らさない（その確認事項で合計は出ない）。
  // 税込みの合計の確認事項はここで数えない: 行の金額は確かなので、税込みと一緒に言った税抜きの合計は照らす
  // （「合計6600円、税込みで7260円」は税込みの 1 件だけ、「合計6000円、税込みで…」は 2 件）。
  const others = priced.confirmations.length + out.length;
  const amounts = priced.lines.map((l) => l.amount);
  const computed =
    others === 0 && amounts.every((a): a is number => a !== null) ? amounts.reduce((s, a) => s + a, 0) : null;
  for (const c of candidates) {
    if (c.kind !== "total") continue;
    if (c.taxIncluded === true) {
      out.push({
        lineIndex: -1,
        item: c.text,
        field: "total",
        message: `「${c.text}」（税率が決まっていないので、税込みの合計は照らせない）`,
      });
      continue;
    }
    if (computed !== null && c.value !== computed) {
      out.push({
        lineIndex: -1,
        item: c.text,
        field: "total",
        message: `「${c.text}」（言った合計と計算が違う: 計算は ${computed} 円）`,
      });
    }
  }
  return out;
}
