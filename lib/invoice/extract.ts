import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { claude, MODEL_MAIN } from "../claude";
import { transcriptToText } from "../stt/manual";
import type { Transcript } from "../stt/types";
import { InvoiceDraft } from "./schema";
import { MAX_QUOTE_SEC } from "./verify";

const SYSTEM = `あなたは青森市の自動車整備工場で、父（整備士）の声から請求の明細を作る書記です。
守ること:
- 言っていない作業・部品を明細にしない。録音に出た作業だけを 1 行ずつ書く。同じ作業を 2 行に分けない。
- 単価と数量を推測で埋めない。発話で明示されていなければ null。
- 数量（qty）は、発話で「数＋単位」（「4本」「2個」など）として言われた数をそのまま使う。足したり換算したりしない。
- 単位（unit）は、その数量に付いた発話の単位（本・個・台・セットなど）をそのまま書く。料金表の単位に合わせて書き換えない。
- 単価（unitPrice）は、発話に 1 単位あたりの金額（「1本330円」「単価330円」の形）があるときだけ入れる。合計額・総額・料金表の値は単価に入れない。それ以外は null（料金表の値は後で別に照らす）。
- 品目名（item）は、料金表の品目名に合うものはその名前を使う。合うものが無ければ発話の言葉のまま。
- 出所（provenance）の quote は発話をそのまま連続して写す（途中を省いたり、離れた発話をつないだりしない）。津軽弁・俗称を標準語に直さない。
- quote には、その行の品目の言葉と、数量（数＋単位）を言った発話を含める。単価を入れた行は、1 単位あたりの金額を言った発話も含める。数量と金額は、それぞれ 1 つの発話の中で言われた形のまま写す。
- startSec・endSec は、quote に写した発話の始まりと終わりの時刻にする。quote は ${MAX_QUOTE_SEC} 秒以内に収める。
- speaker は、その発話の話者をそのまま書く。文字起こしで話者が「?」の発話（録音に話者情報が無い）は推測せず unknown にする。`;

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
