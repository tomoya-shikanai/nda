import type { Transcript } from "../stt/types";
import type { KarteDraft } from "./schema";

type Prov = KarteDraft["checks"][number]["provenance"];

/** 句読点と空白の揺れだけ無視する。語は直さない。 */
export function normalize(s: string): string {
  return s.replace(/[\s、。，．,.!?！？「」『』…・ー-]/g, "");
}

export function allProvenance(d: KarteDraft): Prov[] {
  return [
    ...d.symptoms.map((x) => x.provenance),
    ...d.checks.map((x) => x.provenance),
    ...d.senses.map((x) => x.provenance),
    ...d.decision.reasons.map((x) => x.provenance),
  ];
}

const SLACK_SEC = 1;

/**
 * 出所の後検証。モデルの主張を信じず、文字起こしと機械的に突き合わせる。
 * 不合格が 1 つでもあるカルテは承認できない（scripts/approve.ts）。
 */
export function verifyDraft(d: KarteDraft, t: Transcript): string[] {
  const failures: string[] = [];
  for (const p of allProvenance(d)) {
    const label = `「${p.quote}」`;
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
