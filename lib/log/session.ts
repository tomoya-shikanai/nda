/**
 * 作業ファイルの書き込みの前後の差から、作業の出来事を取り出す（store.ts の writeSession が呼ぶ）。
 * 経路（声・画面・事務所の返し・見回り）によらず、作業の変化は全部ここを通る。純粋な関数（sessionEvents）。
 * 文字起こし・答えの言葉（provenance.quote）・客は見ない。数・種類名・id だけを取り出す。
 */
import { UNREAD_REASONS } from "../session/answer";
import type { Session } from "../session/store";
import { type EventFields, type EventKind, logEvent } from "./events";

export type SessionEvent = { [K in EventKind]: { kind: K; fields: EventFields<K> } }[EventKind];

/** 答えを読めなかった理由を、記録してよい札にする（固定の文はそのまま、抽出の失敗はまとめる、それ以外は other）。 */
export function unreadCode(reason: string): EventFields<"session.answer">["unreadReason"] {
  if ((UNREAD_REASONS as readonly string[]).includes(reason)) return reason as (typeof UNREAD_REASONS)[number];
  if (reason.startsWith("抽出に失敗")) return "抽出に失敗";
  return "other";
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** prev の後ろに足された（か、置き換わった）要素の添字。 */
function changedFrom<T>(prev: readonly T[], next: readonly T[]): number {
  let i = 0;
  while (i < prev.length && i < next.length && same(prev[i], next[i])) i++;
  return i;
}

const ms = (from: string | null | undefined, to: string | null | undefined) => {
  if (!from || !to) return null;
  const d = Date.parse(to) - Date.parse(from);
  return Number.isFinite(d) && d >= 0 ? d : null;
};

export function sessionEvents(prev: Session | null, next: Session): SessionEvent[] {
  const out: SessionEvent[] = [];
  const sessionId = next.id;
  if (prev === null) out.push({ kind: "session.created", fields: { sessionId, customerRequired: next.customerRequired } });

  const ph = prev?.history ?? [];
  for (let i = changedFrom(ph, next.history); i < next.history.length; i++) {
    out.push({ kind: "session.transition", fields: { sessionId, from: next.history[i - 1]?.status ?? null, to: next.history[i].status } });
  }

  const pa = prev?.answers ?? [];
  for (let i = changedFrom(pa, next.answers); i < next.answers.length; i++) {
    const a = next.answers[i];
    const q = (prev ?? next).questions[a.questionIndex];
    out.push({
      kind: "session.answer",
      fields: {
        sessionId,
        questionReason: q?.reason ?? null,
        action: a.action.kind,
        unreadReason: a.action.kind === "unread" ? unreadCode(a.action.reason) : null,
      },
    });
  }

  if (next.approved && !prev?.approved) {
    out.push({
      kind: "session.approved",
      fields: { sessionId, msFromCreated: ms(next.createdAt, next.approvedAt) ?? 0, answers: next.answers.length },
    });
  }

  const q = next.customerQuery;
  const pq = prev?.customerQuery ?? null;
  if (q !== null && q.status !== "pending" && (pq === null || pq.id !== q.id || pq.status !== q.status)) {
    out.push({
      kind: "session.query",
      fields: { sessionId, queryId: q.id, status: q.status, retryReason: q.retryReason as EventFields<"session.query">["retryReason"] },
    });
  }

  const r = next.office?.result ?? null;
  if (next.office !== null && r !== null && prev?.office?.result?.id !== r.id) {
    out.push({
      kind: "session.office",
      fields: {
        sessionId,
        requestId: next.office.requestId,
        outcome: r.outcome as EventFields<"session.office">["outcome"],
        reason: r.reason as EventFields<"session.office">["reason"],
        enteredLines: r.enteredLines,
        attempt: next.office.attempt,
        msFromApproved: ms(next.approvedAt, r.at),
      },
    });
  }
  return out;
}

/** 差の出来事を記録する。投げない。 */
export function logSessionChange(prev: Session | null, next: Session): void {
  try {
    for (const e of sessionEvents(prev, next)) logEvent(e.kind, e.fields as never);
  } catch {
    // 記録の失敗で本体を止めない
  }
}
