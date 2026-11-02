import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { claude, MODEL_MAIN } from "../claude";
import type { Karte } from "../karte/schema";
import { allProvenance, normalize } from "../karte/verify";

export const STOP_MESSAGE = "まいね。まだ父さ聞いでね";

const Answer = z.object({
  answerable: z.boolean().describe("承認済みカルテだけで答えられるか。少しでも範囲外なら false"),
  answer: z.string().nullable().describe("答え。父の言葉と確かめた順に基づく。answerable=false なら null"),
  checkOrder: z.array(z.string()).describe("父ならどこから確かめるか、の順。カルテの checks から"),
  cited: z
    .array(
      z.object({
        karteId: z.string(),
        recordingId: z.string(),
        startSec: z.number(),
        endSec: z.number(),
        quote: z.string(),
      }),
    )
    .describe("根拠にした原文と時刻。ここから原音を再生する"),
  whyNot: z.string().nullable().describe("答えられない理由（どの条件が父に未確認か）"),
});
export type SonAnswer = z.infer<typeof Answer>;

const SYSTEM = `あなたは整備士の息子の問いに、父が「んだ」と承認したカルテだけで答える係です。
- 承認済みカルテに無いことは答えない。一般的な整備知識で補わない。
- 問いの条件がカルテの条件と一つでも違い、その違いが判断に関わるなら answerable=false。
- 答えるときは必ず cited に根拠の原文と時刻を入れる。cited が空なら answerable=false。
- 「父ならどこから確かめるか」を checkOrder に、カルテの確かめた順のまま出す。`;

/** モデルに渡す範囲。父が承認していない一問の回答は渡さない。 */
export function karteView(k: Karte) {
  return {
    id: k.id,
    recordingId: k.recordingId,
    summary: k.summary,
    symptoms: k.symptoms,
    checks: k.checks,
    senses: k.senses,
    decision: k.decision,
    approvedCondition:
      k.question?.fired && k.question.answerApproved === true
        ? { question: k.question.text, answer: k.question.answer }
        : null,
  };
}

/** 引用が承認済みカルテの出所と一致するか。不一致の説明を返す。 */
export function citationFailures(cited: SonAnswer["cited"], approved: Karte[]): string[] {
  return cited.flatMap((c) => {
    const k = approved.find((x) => x.id === c.karteId && x.status === "approved");
    if (!k) return [`承認済みカルテに無い: ${c.karteId}`];
    const hit = allProvenance(k).some(
      (p) =>
        p.recordingId === c.recordingId &&
        p.startSec === c.startSec &&
        p.endSec === c.endSec &&
        normalize(p.quote) === normalize(c.quote),
    );
    return hit ? [] : [`出所と一致しない引用:「${c.quote}」`];
  });
}

export async function ask(question: string, approvedInput: Karte[]): Promise<SonAnswer> {
  const approved = approvedInput.filter((k) => k.status === "approved");
  if (approved.length === 0) {
    return { answerable: false, answer: null, checkOrder: [], cited: [], whyNot: "承認済みカルテが 0 件" };
  }
  const res = await claude().messages.parse({
    model: MODEL_MAIN,
    max_tokens: 6000,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `息子の問い: ${question}`,
          "承認済みカルテ:",
          JSON.stringify(approved.map(karteView), null, 1),
        ].join("\n\n"),
      },
    ],
    output_config: { format: zodOutputFormat(Answer) },
  });
  const a = res.parsed_output;
  if (!a) throw new Error("息子の問いの出力を解釈できない");
  if (!a.answerable || a.cited.length === 0) {
    return { ...a, answerable: false, answer: null };
  }
  const bad = citationFailures(a.cited, approved);
  if (bad.length > 0) {
    return { answerable: false, answer: null, checkOrder: [], cited: [], whyNot: bad.join(" / ") };
  }
  return a;
}
