/**
 * mlx_whisper の JSON を共通の文字起こし形に変換する。話者は分からないので null のまま。
 * 使い方: pnpm tsx scripts/whisper-to-transcript.ts <whisper.json> <recordingId> <vendor>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Transcript } from "../lib/stt/types";

const [input, recordingId, vendor] = process.argv.slice(2);
if (!input || !recordingId || !vendor) {
  console.error("usage: tsx scripts/whisper-to-transcript.ts <whisper.json> <recordingId> <vendor>");
  process.exit(1);
}
const raw = JSON.parse(await readFile(input, "utf8")) as {
  segments: { start: number; end: number; text: string }[];
};
const t: Transcript = {
  recordingId,
  vendor,
  language: "ja",
  glossaryHint: false,
  segments: raw.segments.map((s) => ({
    startSec: s.start,
    endSec: s.end,
    speaker: null,
    text: s.text.trim(),
  })),
};
await mkdir("data/transcripts", { recursive: true });
const out = `data/transcripts/${recordingId}.${vendor}.json`;
await writeFile(out, JSON.stringify(t, null, 2));
console.log(out);
