import { readFile } from "node:fs/promises";
import type { Transcript } from "./types";

/** 手で起こした文字起こし JSON を読む。配管テストと、STT が決まる前の素材用。 */
export async function loadTranscript(path: string): Promise<Transcript> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Transcript;
  if (!raw.recordingId || !Array.isArray(raw.segments)) {
    throw new Error(`transcript の形が違う: ${path}`);
  }
  return raw;
}

export function transcriptToText(t: Transcript): string {
  return t.segments
    .map((s) => `[${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}] ${s.speaker ?? "?"}: ${s.text}`)
    .join("\n");
}
