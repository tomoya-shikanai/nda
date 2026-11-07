/**
 * 工場（Pi）と事務所（PC）のあいだのメッセージ（#25、docs/design/pi-office.md §3・§9）。zod が正。
 * 事務所の Python は scripts/office-schema.ts が書き出す office/box/schema/*.json で検証する（手で二重に書かない）。
 * node の API を使わない（画面からも型を読む）。
 */
import { z } from "zod";

export const SessionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** どの声のどの発話か。 */
export const Where = z.object({ recordingId: z.string(), startSec: z.number(), endSec: z.number() });
/** quote は伏せ字にした後の文（名前と 4 桁は ＊＊）。承認済みの請求の行と承認の発話だけに入れる。 */
export const Quoted = Where.extend({ quote: z.string() });

export const Envelope = z.object({
  v: z.literal(1),
  /** メッセージの一意 ID。二重に届いたときの判定に使う。 */
  id: z.string().uuid(),
  /** 工場の作業 ID。入力の二重を止める鍵。 */
  sessionId: SessionId,
  /** 送った側の時計。順序や期限の判定には使わない（時計のずれ）。 */
  sentAt: z.string().datetime(),
});

/** 工場→事務所: 客の照合の問い合わせ。 */
export const CustomerQuery = Envelope.extend({
  kind: z.literal("customer.query"),
  /** 4 桁の数を含む文だけ（伏せ字にする前の原文）。工場は保存せず、事務所は答えた直後にファイルを消す。 */
  said: z.array(z.string().min(1)).min(1),
  /** 文に出た 4 桁の数（円が続かないもの）。 */
  plate4: z.array(z.string().regex(/^[0-9]{4}$/)).min(1),
  from: Where,
  /** 事務所が受け取ってからこの秒数を過ぎた問い合わせは答えない（父は次に進んでいる）。 */
  ttlSec: z.number().int().positive(),
});
export type CustomerQuery = z.infer<typeof CustomerQuery>;

/** 事務所→工場: 照合の答え。名前の全体は返さない。label は姓と車種（§9-1。画面に出すだけで、工場は保存しない）。 */
export const CustomerAnswer = Envelope.extend({
  kind: z.literal("customer.answer"),
  queryId: z.string().uuid(),
  result: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("found"),
      customerNo: z.string().min(1),
      carNo: z.string().min(1),
      /** 姓と車種（例「〇〇 様・軽トラ」）。出さないなら null。 */
      label: z.string().nullable(),
    }),
    z.object({ status: z.literal("retry"), reason: z.enum(["none", "many", "expired", "dbUnavailable"]) }),
  ]),
});
export type CustomerAnswer = z.infer<typeof CustomerAnswer>;

/** 工場→事務所: 承認済みの請求（入力の依頼）。確認事項 0 件・客が決まった作業だけ。値はすべて埋まっている。 */
export const InvoiceRequest = Envelope.extend({
  kind: z.literal("invoice.request"),
  /** 同じ作業の何回目の依頼か。前回が stopped のときだけ 2 以上を送れる。 */
  attempt: z.number().int().positive(),
  customer: z.object({ customerNo: z.string().min(1), carNo: z.string().min(1) }),
  approvedAt: z.string().datetime(),
  /** 「請求書頼む」と言った発話。 */
  approval: Quoted,
  lines: z
    .array(
      z.object({
        /** 料金表の正式名。 */
        item: z.string().min(1),
        qty: z.number().positive(),
        unit: z.string().min(1),
        unitPrice: z.number().int().nonnegative(),
        amount: z.number().int().nonnegative(),
        unitPriceFrom: z.enum(["ledger", "spoken", "answer"]),
        /** 品目を言った発話。 */
        provenance: Quoted,
      }),
    )
    .min(1),
  total: z.number().int().nonnegative(),
  /** 父が言った合計。言っていなければ null。 */
  totalSpoken: z.number().int().nullable(),
});
export type InvoiceRequest = z.infer<typeof InvoiceRequest>;

export const INVOICE_OUTCOMES = ["entered", "stopped", "deferred", "withdrawn", "saved"] as const;
export const INVOICE_REASONS = [
  "busy",
  "appNotRunning",
  "unknownItem",
  "customerNotAllowed",
  "customerNotFound",
  "duplicate",
  "invalid",
  "readbackMismatch",
  "other",
] as const;

/** 事務所→工場: 入力の結果。11/7 は entered と stopped だけ使う。 */
export const InvoiceResult = Envelope.extend({
  kind: z.literal("invoice.result"),
  requestId: z.string().uuid(),
  outcome: z.enum(INVOICE_OUTCOMES),
  enteredLines: z.number().int().nonnegative(),
  reason: z.enum(INVOICE_REASONS).nullable(),
  /** 画面から読み返した値。読めなければ null（推測で埋めない）。 */
  readback: z.array(z.object({ item: z.string(), qty: z.number().nullable(), unitPrice: z.number().nullable() })).nullable(),
  /** 事務所の PC に残した画面の写真のファイル名。写真そのものは送らない。 */
  screenshotFile: z.string().nullable(),
});
export type InvoiceResult = z.infer<typeof InvoiceResult>;

export const ToOffice = z.discriminatedUnion("kind", [CustomerQuery, InvoiceRequest]);
export type ToOffice = z.infer<typeof ToOffice>;
export const ToFactory = z.discriminatedUnion("kind", [CustomerAnswer, InvoiceResult]);
export type ToFactory = z.infer<typeof ToFactory>;

/** 受け箱のファイル名（`<kind>-<sessionId>-<id>.json`）。 */
export const boxFileName = (m: ToOffice) => `${m.kind}-${m.sessionId}-${m.id}.json`;

/** 書き出す JSON Schema の名前と型（scripts/office-schema.ts と試験が使う）。 */
export const SCHEMAS = {
  "customer.query": CustomerQuery,
  "customer.answer": CustomerAnswer,
  "invoice.request": InvoiceRequest,
  "invoice.result": InvoiceResult,
  "to-office": ToOffice,
  "to-factory": ToFactory,
} as const;
