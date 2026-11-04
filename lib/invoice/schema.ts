import { z } from "zod";
import { Provenance } from "../karte/schema";

/** 請求の明細 1 行。単価と数量は発話に無ければ null。推測で埋めない。 */
export const InvoiceLine = z.object({
  item: z.string().describe("作業・部品の名前。料金表の品目名に合うものはその名前"),
  qty: z.number().nullable().describe("数量。言っていなければ null"),
  unit: z.string().nullable().describe("単位（本・個・式など）。言っていなければ null"),
  unitPrice: z
    .number()
    .nullable()
    .describe("単価（円）。発話で金額が明示されたときだけ。それ以外は null"),
  provenance: Provenance,
});
export type InvoiceLine = z.infer<typeof InvoiceLine>;

export const InvoiceDraft = z.object({
  lines: z.array(InvoiceLine).describe("発話で言った作業・部品だけ。言っていない作業は入れない"),
});
export type InvoiceDraft = z.infer<typeof InvoiceDraft>;

/**
 * モデルが書く明細 1 行の参照（設計 docs/design/invoice-verify.md の (b)・(c)）。数字は書かせず、候補の ID を指す。
 * 値は resolveInvoice がコードで戻す。
 */
export const LineRef = z.object({
  item: z
    .union([z.string(), z.object({ seg: z.number(), text: z.string() })])
    .describe("品目。item 候補の ID か、料金表に無い品目なら発話の添字とその語"),
  qty: z.string().nullable().describe("数量の候補の ID。言っていなければ null"),
  unitPrice: z.string().nullable().describe("単価の候補の ID。言っていなければ null"),
  amount: z.string().nullable().describe("金額の候補の ID。言っていなければ null"),
  status: z
    .enum(["done", "negated", "corrected", "unsure"])
    .describe("done やった／negated 否定・取り消し・断り／corrected 言い直し／unsure 確かでない"),
  evidence: z.array(z.string()).describe("判定の根拠の候補 ID。done 以外のとき入れる"),
  correctedFrom: z.string().nullable().describe("言い直しの訂正前の数の候補 ID。言い直しでなければ null"),
  correctedTo: z.string().nullable().describe("言い直しの訂正後の数の候補 ID。言い直しでなければ null"),
});
export type LineRef = z.infer<typeof LineRef>;

/** 否定・取り消し・断りに当たる文。発話の添字と、その文を原文のまま。 */
export const NegatedSentence = z.object({
  seg: z.number().describe("発話の添字"),
  text: z.string().describe("否定・取り消し・断りに当たる文。原文のまま"),
});
export type NegatedSentence = z.infer<typeof NegatedSentence>;

/** モデルが返す参照の全体（行と、否定の文）。 */
export const InvoiceRefs = z.object({
  lines: z.array(LineRef),
  negations: z.array(NegatedSentence),
});
export type InvoiceRefs = z.infer<typeof InvoiceRefs>;
