import { normalize } from "../karte/verify";
import type { Transcript } from "../stt/types";
import type { InvoiceDraft } from "./schema";

const SLACK_SEC = 1;

/**
 * 明細の後検証。出所は verifyDraft と同じ規則で文字起こしと突き合わせる。
 * 単価は、引用の中に「その数字＋円」が無ければ不合格（推測で埋めない）。
 */
export function verifyInvoice(d: InvoiceDraft, t: Transcript): string[] {
  const failures: string[] = [];
  for (const line of d.lines) {
    const p = line.provenance;
    const label = `${line.item}「${p.quote}」`;
    if (line.unitPrice !== null && !normalize(p.quote).includes(`${line.unitPrice}円`)) {
      failures.push(`${label}: 単価が発話に無い (${line.unitPrice}円)`);
    }
    if (p.recordingId !== t.recordingId) {
      failures.push(`${label}: 録音 ID が違う (${p.recordingId})`);
      continue;
    }
    if (!(p.startSec < p.endSec)) {
      failures.push(`${label}: 時刻範囲が不正 (${p.startSec}-${p.endSec})`);
      continue;
    }
    const near = t.segments.filter(
      (s) => s.endSec >= p.startSec - SLACK_SEC && s.startSec <= p.endSec + SLACK_SEC,
    );
    const key = normalize(p.quote);
    if (!key || !normalize(near.map((s) => s.text).join("")).includes(key)) {
      failures.push(`${label}: 指定の時刻付近の文字起こしに無い (${p.startSec}-${p.endSec}s)`);
      continue;
    }
    if (p.speaker !== "unknown" && near.every((s) => s.speaker === null)) {
      failures.push(`${label}: 話者情報が無い録音で話者を ${p.speaker} と推定している`);
    }
  }
  return failures;
}
