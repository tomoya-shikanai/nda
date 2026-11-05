/**
 * 答えで除いた後に残る行（W4）。node の API を使わない（画面の client component が view.ts 経由で読む）。
 */
import type { Answer } from "./store";

/**
 * 答えで除いた後に残る行の、resolveInvoice の行の添字（元の並び）。n は resolve の行の数。
 * 範囲外の drop は無視する。applyAnswers と画面の出所（view.ts）が同じ規則で使う。
 */
export function keptLines(n: number, answers: Answer[]): number[] {
  const dropped = new Set(
    answers.filter((a) => a.action.kind === "drop" && a.lineIndex >= 0 && a.lineIndex < n).map((a) => a.lineIndex),
  );
  return Array.from({ length: n }, (_, i) => i).filter((i) => !dropped.has(i));
}
