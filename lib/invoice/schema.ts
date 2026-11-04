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
