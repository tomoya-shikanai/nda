/**
 * gemini-3.5-transcribe で文字起こしする（W6）。要求の形は scripts/stt-compare.ts の geminiTranscribe と同じ
 * （Interactions API、本文は steps[type=model_output].content[].text）。
 *
 * 時刻と話者は取らない（custom_vocabulary と併用できないと docs/research.md にある。取り方は実録音の後に決める）。
 * なので 1 発話 { startSec: 0, endSec: WAV の長さ, speaker: null, text } にする。WAV でなければ throw（長さを推測しない）。
 * model_output の content に text の無いブロックがあれば throw する（黙って捨てない）。出口で TranscriptSchema を通す。
 */
import { redact, type SttAudio } from "./scribe";
import { type Transcript, TranscriptSchema } from "./types";
import { wavDurationSec } from "./wav";

const URL_INTERACTIONS = "https://generativelanguage.googleapis.com/v1beta/interactions";

export async function transcribeGemini(
  audio: SttAudio,
  opts: { apiKey: string; fetch?: typeof fetch; vocabulary?: string[] },
): Promise<Transcript> {
  const f = opts.fetch ?? fetch;
  const endSec = wavDurationSec(audio.data); // 先に確かめる。WAV でなければ API を呼ばない
  const vocabulary = opts.vocabulary ?? [];
  const body = {
    model: "models/gemini-3.5-transcribe",
    input: [{ type: "audio", mime_type: audio.mimeType, data: Buffer.from(audio.data).toString("base64") }],
    generation_config: {
      transcription_config: {
        language_codes: ["ja-JP"],
        ...(vocabulary.length > 0 ? { custom_vocabulary: vocabulary } : {}),
      },
    },
  };
  const r = await f(URL_INTERACTIONS, {
    method: "POST",
    headers: { "x-goog-api-key": opts.apiKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(redact(`gemini-transcribe ${r.status} ${text.slice(0, 200)}`, opts.apiKey));
  }
  const j = (await r.json()) as { steps?: { type: string; content?: { type: string; text?: unknown }[] }[] };
  const outputs = (j.steps ?? []).filter((s) => s.type === "model_output");
  if (outputs.some((s) => !Array.isArray(s.content))) {
    throw new Error("gemini-transcribe の応答に content の無い model_output がある");
  }
  const blocks = outputs.flatMap((s) => s.content as { type: string; text?: unknown }[]);
  if (blocks.some((c) => typeof c.text !== "string")) {
    throw new Error("gemini-transcribe の応答に text の無いブロックがある");
  }
  const text = blocks
    .map((c) => c.text as string)
    .join("")
    .trim();
  if (!text) throw new Error("gemini-transcribe の応答に本文が無い");
  return TranscriptSchema.parse({
    recordingId: audio.recordingId,
    vendor: "gemini-3.5-transcribe",
    language: "ja",
    segments: [{ startSec: 0, endSec, speaker: null, text }],
    glossaryHint: vocabulary.length > 0,
  });
}
