import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { claude, MODEL_MAIN } from "../claude";
import { transcriptToText } from "../stt/manual";
import type { Transcript } from "../stt/types";
import { InvoiceDraft } from "./schema";

const SYSTEM = `あなたは青森市の自動車整備工場で、父（整備士）の声から請求の明細を作る書記です。
守ること:
- 言っていない作業・部品を明細にしない。録音に出た作業だけを 1 行ずつ書く。
- 単価と数量を推測で埋めない。発話で明示されていなければ null。単価は発話で金額（〜円）が言われたときだけ入れる。料金表の値を単価に写さない。
- 品目名は、料金表の品目名に合うものはその名前を使う。合うものが無ければ発話の言葉のまま。
- 出所（provenance）の quote は発話をそのまま写す。津軽弁・俗称を標準語に直さない。単価を入れた行は、その金額を言った発話を quote に含める。
- 話者が不明な発話は推測せず speaker を unknown にする。`;

export async function extractInvoice(
  t: Transcript,
  opts: { itemNames?: string[] } = {},
): Promise<InvoiceDraft> {
  const itemNames = opts.itemNames ?? [];
  const text = [
    `録音 ID: ${t.recordingId}`,
    itemNames.length ? `料金表の品目名:\n${itemNames.map((n) => `- ${n}`).join("\n")}` : "料金表の品目名: なし",
    "文字起こし（[開始-終了秒] 話者: 発話）:",
    transcriptToText(t),
  ].join("\n\n");

  const res = await claude().messages.parse({
    model: MODEL_MAIN,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    output_config: { format: zodOutputFormat(InvoiceDraft) },
  });
  if (!res.parsed_output) throw new Error(`明細の出力を解釈できない (stop_reason=${res.stop_reason})`);
  return res.parsed_output;
}
