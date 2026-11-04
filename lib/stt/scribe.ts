/**
 * ElevenLabs Scribe v2 で文字起こしする（W6）。要求の形は scripts/stt-compare.ts の scribe に、
 * 話者分離（diarize）と語ごとの時刻（timestamps_granularity=word）を足したもの。
 *
 * 応答の形（words の { text, start, end, type, speaker_id? }）は公式文書に基づく。
 * 実 API ではまだ確かめていないので、朝に実 API で 1 回確かめる。
 *
 * 発話の分け方: speaker_id が変わるか、語が「。」「？」「！」で終わったら区切る。
 * 誰が父かの対応付けはしない（speaker は speaker_id のまま。無ければ null）。
 * words が無い・空なら throw する（応答の text を 1 発話にして時刻を推測しない）。
 * 語は type・text・start・end が必須で、欠けた語があれば throw する（黙って捨てない）。出口で TranscriptSchema を通す。
 */
import { z } from "zod";
import { type Segment, type Transcript, TranscriptSchema } from "./types";

export type SttAudio = { data: Uint8Array; mimeType: string; recordingId: string };

const ScribeWord = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  type: z.string(),
  speaker_id: z.string().nullish(),
});
type ScribeWord = z.infer<typeof ScribeWord>;

const URL_SCRIBE = "https://api.elevenlabs.io/v1/speech-to-text";
const SENTENCE_END = /[。？！?!]$/;

/** エラーの文にキーの値が入らないようにする。 */
export function redact(s: string, secret: string): string {
  return secret ? s.split(secret).join("***") : s;
}

export function wordsToSegments(words: ScribeWord[]): Segment[] {
  const segs: Segment[] = [];
  let cur: { speaker: string | null; startSec: number; endSec: number; text: string } | null = null;
  const close = () => {
    if (cur) segs.push({ startSec: cur.startSec, endSec: cur.endSec, speaker: cur.speaker, text: cur.text.trim() });
    cur = null;
  };
  for (const w of words) {
    if (w.type === "spacing") {
      if (cur) cur.text += w.text; // 発話の頭の空白は捨てる
      continue;
    }
    if (w.type !== "word") continue; // audio_event などは捨てる
    const speaker = w.speaker_id ?? null;
    if (cur && cur.speaker !== speaker) close();
    if (!cur) cur = { speaker, startSec: w.start, endSec: w.end, text: "" };
    cur.text += w.text;
    cur.endSec = w.end;
    if (SENTENCE_END.test(w.text)) close();
  }
  close();
  return segs;
}

export async function transcribeScribe(
  audio: SttAudio,
  opts: { apiKey: string; fetch?: typeof fetch; keyterms?: string[] },
): Promise<Transcript> {
  const f = opts.fetch ?? fetch;
  const keyterms = opts.keyterms ?? [];
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("language_code", "jpn");
  form.append("tag_audio_events", "false");
  form.append("diarize", "true");
  form.append("timestamps_granularity", "word");
  for (const k of keyterms) form.append("keyterms", k);
  form.append("file", new Blob([audio.data as Uint8Array<ArrayBuffer>], { type: audio.mimeType }), "audio");

  const r = await f(URL_SCRIBE, { method: "POST", headers: { "xi-api-key": opts.apiKey }, body: form });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(redact(`scribe ${r.status} ${body.slice(0, 200)}`, opts.apiKey));
  }
  const j = (await r.json()) as { words?: unknown };
  if (!Array.isArray(j.words) || j.words.length === 0) {
    throw new Error("scribe の応答に words が無い（時刻を推測しない）");
  }
  const words = j.words.map((w, i) => {
    const p = ScribeWord.safeParse(w);
    if (!p.success) throw new Error(`scribe の応答の語 ${i} に type・text・start・end が揃っていない`);
    return p.data;
  });
  const segments = wordsToSegments(words);
  if (segments.length === 0) throw new Error("scribe の応答に語が無い（時刻を推測しない）");
  return TranscriptSchema.parse({
    recordingId: audio.recordingId,
    vendor: "scribe_v2",
    language: "ja",
    segments,
    glossaryHint: keyterms.length > 0,
  });
}
