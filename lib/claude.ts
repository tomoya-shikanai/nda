import Anthropic from "@anthropic-ai/sdk";

export const MODEL_MAIN = "claude-opus-5-5"; // 分離・一問・息子の問い
export const MODEL_AUX = "claude-haiku-5-5"; // 補助（語彙候補など）
export const MODEL_TALK = process.env.NDA_TALK_MODEL || "claude-sonnet-5-5"; // 会話の受け皿（速さ優先）

let client: Anthropic | null = null;
export function claude(): Anthropic {
  if (!client) client = new Anthropic(); // ANTHROPIC_API_KEY は環境変数から
  return client;
}
