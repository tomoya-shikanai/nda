/**
 * 声の入口の振り分けと、声の返事の文字起こしを答えの 1 発話にする所（現場の聞き役 device/listener から使う）。
 * 純粋な関数。入力を書き換えない。API を呼ばない。
 */
import type { Segment, Transcript } from "../stt/types";
import type { Session } from "./store";

export type VoiceRoute = { kind: "answer"; id: string } | { kind: "new" };

/**
 * 最新の作業が asking（質問中か承認待ち）なら、声はその返事。それ以外（無い・done・抽出の失敗の idle・途中の状態）は新しい作業。
 * 承認待ちは asking で確認事項が 0 件の状態（view.ts の awaitingApproval）なので、asking だけを見れば両方を含む。
 */
export function routeVoice(latest: Session | null): VoiceRoute {
  if (latest !== null && latest.status === "asking") return { kind: "answer", id: latest.id };
  return { kind: "new" };
}

/**
 * 返事の録音の文字起こしを、答えの 1 発話にする。発話が複数なら、文字をそのままつなぎ、時刻は最初の開始から最後の終了まで。
 * 話者は全発話で同じときだけ残し、違えば null（どれか 1 人の声とは決めない）。
 * つないだ文字に余計な語が残れば answer.ts が unread にする（言い直しを黙って 1 つに選ばない）。発話が無ければ throw。
 */
export function answerUtterance(t: Transcript): Segment {
  const segs = t.segments;
  if (segs.length === 0) throw new Error("返事の文字起こしに発話が無い");
  const speakers = new Set(segs.map((s) => s.speaker));
  return {
    startSec: segs[0].startSec,
    endSec: Math.max(...segs.map((s) => s.endSec)),
    speaker: speakers.size === 1 ? segs[0].speaker : null,
    text: segs.map((s) => s.text).join(""),
  };
}
