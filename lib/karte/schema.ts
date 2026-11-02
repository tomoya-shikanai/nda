import { z } from "zod";

/** 誰が言ったか。客の推測・父の観察・モデルの推論を混ぜないための種別。 */
export const Speaker = z.enum(["father", "customer", "son", "unknown"]);
export const Kind = z.enum(["customer_guess", "father_observation", "model_inference"]);

/** 出所: 録音 ID・時刻範囲・話者・原文。承認時にここを原音で確認する。 */
export const Provenance = z.object({
  recordingId: z.string(),
  startSec: z.number(),
  endSec: z.number(),
  speaker: Speaker,
  quote: z.string().describe("録音に出た言葉をそのまま（方言・俗称を直さない）"),
});

export const KarteItem = z.object({
  text: z.string().describe("標準語での短い要約"),
  kind: Kind,
  provenance: Provenance,
});

/** 確かめた順。息子の問い「父ならどこから確かめる？」の答えになる。 */
export const Check = z.object({
  order: z.number().int().describe("父が確かめた順番。1 から"),
  what: z.string().describe("確かめた箇所"),
  how: z.string().nullable().describe("どうやって確かめたか。不明なら null"),
  result: z.string().nullable().describe("分かったこと。不明なら null"),
  provenance: Provenance,
});

export const Sense = z.object({
  modality: z.enum(["sound", "smell", "feel", "sight", "other"]),
  text: z.string().describe("父の感じたこと。原文の表現を残す"),
  provenance: Provenance,
});

export const Decision = z.object({
  action: z.enum(["fix", "replace", "defer", "undetermined"]).describe("直す／替える／見送る／未定"),
  target: z.string().describe("対象の部品・箇所"),
  reasons: z.array(KarteItem).describe("父がそう決めた理由。父の言葉に無い理由は作らない"),
  conditions: z.array(z.string()).describe("この判断が成り立つ前提条件のうち、説明に出たもの"),
});

export const WorkLine = z.object({
  item: z.string(),
  qty: z.number().nullable(),
  unit: z.string().nullable(),
  note: z.string().nullable(),
});

export const MissingCondition = z.object({
  what: z.string().describe("別の案件でこの判断を再利用するために欠けている条件"),
  whyNeeded: z.string().describe("なぜ無いと誤った一般化が起きるか"),
});

export const GlossaryHit = z.object({
  heard: z.string().describe("録音に出た語（方言・俗称・業者名）"),
  standard: z.string().nullable().describe("標準語・正式名。確信が無ければ null"),
});

export const KarteDraft = z.object({
  summary: z.string().describe("一行要約。標準語"),
  symptoms: z.array(KarteItem).describe("症状。客の言葉は customer_guess、父の観察は father_observation"),
  checks: z.array(Check),
  senses: z.array(Sense),
  decision: Decision,
  workLines: z.array(WorkLine).describe("作業行。単価や金額は書かない（台帳で照合する）"),
  missingConditions: z.array(MissingCondition),
  glossary: z.array(GlossaryHit),
});
export type KarteDraft = z.infer<typeof KarteDraft>;

export const LedgerResult = z.object({
  item: z.string(),
  found: z.boolean(),
  price: z.number().nullable(),
  unit: z.string().nullable(),
  source: z.string().nullable(),
});
export type LedgerResult = z.infer<typeof LedgerResult>;

export const KarteStatus = z.enum(["draft", "approved", "rejected"]);

export const Karte = KarteDraft.extend({
  id: z.string(),
  recordingId: z.string(),
  createdAt: z.string(),
  status: KarteStatus,
  ledger: z.array(LedgerResult),
  /** 出所の後検証の不合格。1 件でもあれば承認できない。 */
  verificationFailures: z.array(z.string()),
  /** 分岐の一問とその回答。発火しなかった理由も残す。 */
  question: z
    .object({
      arm: z.enum(["extract", "fixed", "claude"]),
      fired: z.boolean(),
      text: z.string().nullable(),
      targetCondition: z.string().nullable(),
      skippedReason: z.string().nullable(),
      answer: z.string().nullable(),
      answerApproved: z.boolean().nullable(),
    })
    .nullable(),
});
export type Karte = z.infer<typeof Karte>;
