import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { claude, MODEL_MAIN } from "../claude";
import type { KarteDraft, Karte } from "./schema";

export type Arm = "extract" | "fixed" | "claude";

export const FIXED_QUESTION = "どの状態なら、今回は逆の判断になりますか？";

export type QuestionResult = {
  arm: Arm;
  fired: boolean;
  text: string | null;
  targetCondition: string | null;
  skippedReason: string | null;
};

/** 発火条件 4 つ。1 つでも欠ければ聞かない。発火率を上げるための質問は作らない。 */
const Selection = z.object({
  decisionRecorded: z.boolean().describe("①判断（直す／替える／見送る）が記録されているか"),
  conditionMissing: z.boolean().describe("②再利用に必要な条件が欠けているか"),
  notFillable: z.boolean().describe("③既存カルテ・台帳で埋まらないか"),
  shortAnswerable: z.boolean().describe("④父が一言で答えられるか"),
  targetCondition: z.string().nullable().describe("聞く対象の欠けた条件。発火しないなら null"),
  question: z.string().nullable().describe("父に聞く一問。短く、具体的に。発火しないなら null"),
  skippedReason: z.string().nullable().describe("発火しない理由。発火するなら null"),
});

const SYSTEM = `あなたは整備士の父に「一問だけ」聞くかどうかを決める係です。
目的は、父の判断を別の案件で誤って一般化しないために欠けている条件を 1 つだけ取ることです。
次の 4 条件をすべて満たすときだけ発火します: ①判断が記録されている ②再利用に必要な条件が欠けている ③既存カルテ・台帳で埋まらない ④父が一言で答えられる。
既に答えが説明に出ている項目は聞かない。質問を増やすための質問は禁止。迷ったら発火しない。
質問は父が客の前でなく後で答える前提で、短く、具体的な状態を聞く（例: 「錆がどこまで進んでいたら替えますか？」）。`;

export async function selectQuestion(
  draft: KarteDraft,
  arm: Arm,
  approvedKartes: Pick<Karte, "summary" | "decision" | "missingConditions">[] = [],
): Promise<QuestionResult> {
  if (arm === "extract") {
    return { arm, fired: false, text: null, targetCondition: null, skippedReason: "抽出のみの腕" };
  }
  if (arm === "fixed") {
    const fired = draft.decision.action !== "undetermined";
    return {
      arm,
      fired,
      text: fired ? FIXED_QUESTION : null,
      targetCondition: null,
      skippedReason: fired ? null : "判断が未定",
    };
  }
  const res = await claude().messages.parse({
    model: MODEL_MAIN,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          "今回のカルテ（下書き）:",
          JSON.stringify(
            {
              summary: draft.summary,
              decision: draft.decision,
              checks: draft.checks.map((c) => ({ order: c.order, what: c.what, result: c.result })),
              missingConditions: draft.missingConditions,
            },
            null,
            1,
          ),
          "承認済みカルテ（既に分かっている条件）:",
          JSON.stringify(approvedKartes, null, 1),
        ].join("\n\n"),
      },
    ],
    output_config: { format: zodOutputFormat(Selection) },
  });
  const s = res.parsed_output;
  if (!s) throw new Error("一問の選択を解釈できない");
  const fired = s.decisionRecorded && s.conditionMissing && s.notFillable && s.shortAnswerable && !!s.question;
  return {
    arm,
    fired,
    text: fired ? s.question : null,
    targetCondition: fired ? s.targetCondition : null,
    skippedReason: fired
      ? null
      : s.skippedReason ??
        `条件未達: ①${s.decisionRecorded} ②${s.conditionMissing} ③${s.notFillable} ④${s.shortAnswerable}`,
  };
}
