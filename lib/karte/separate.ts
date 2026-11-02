import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { readFile } from "node:fs/promises";
import { claude, MODEL_MAIN } from "../claude";
import type { Transcript } from "../stt/types";
import { transcriptToText } from "../stt/manual";
import { KarteDraft } from "./schema";

const SYSTEM = `あなたは青森市の自動車整備工場で、父（整備士）が客に説明している録音からカルテを作る書記です。
守ること:
- 客の推測（customer_guess）と父の観察（father_observation）を混ぜない。話者が不明な発話は推測せず unknown のまま。
- 父の言葉に無い理由・条件・数値を作らない。分からない項目は null か空配列。
- 原文（quote）は録音に出た言葉をそのまま。津軽弁・部品の俗称・業者名を標準語に直さない。標準語は text 側に書く。
- 確かめた順（checks）は、父が実際に確かめた順番で。順番が分からなければ発話順。
- 感じたこと（senses）は音・匂い・手応え・見た目の表現を原文のまま残す。
- 作業行に単価や金額を書かない。台帳で別に照合する。
- missingConditions は「この判断を別の案件で再利用するために欠けている条件」だけ。既に説明に出ている条件は入れない。
- 語彙帳にある語はその対応を使う。無い語は standard を null にする。`;

export async function separate(
  t: Transcript,
  opts: { glossary?: { heard: string; standard: string }[]; photoPath?: string | null } = {},
): Promise<KarteDraft> {
  const glossary = opts.glossary ?? [];
  const content: Anthropic.Messages.ContentBlockParam[] = [];
  if (opts.photoPath) {
    const data = (await readFile(opts.photoPath)).toString("base64");
    const ext = opts.photoPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    content.push({ type: "image", source: { type: "base64", media_type: ext, data } });
  }
  content.push({
    type: "text",
    text: [
      `録音 ID: ${t.recordingId}`,
      glossary.length
        ? `語彙帳:\n${glossary.map((g) => `- ${g.heard} = ${g.standard}`).join("\n")}`
        : "語彙帳: なし",
      "文字起こし（[開始-終了秒] 話者: 発話）:",
      transcriptToText(t),
    ].join("\n\n"),
  });

  const res = await claude().messages.parse({
    model: MODEL_MAIN,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(KarteDraft) },
  });
  if (!res.parsed_output) throw new Error(`分離の出力を解釈できない (stop_reason=${res.stop_reason})`);
  return res.parsed_output;
}
