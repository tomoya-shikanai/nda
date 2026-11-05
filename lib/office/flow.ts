/**
 * 工場側の事務所とのやりとりの、純粋な部分（docs/design/pi-office.md §4・§5・§9）。API を呼ばない、入力を書き換えない。
 * - 照合の問い合わせを組む（4 桁を含む文だけ。said は作業に入れない）
 * - 事務所の返し（customer.answer・invoice.result）を作業に当てる（二重の id・待っていない答えは当てない）
 * - 承認済みの作業から入力の依頼（invoice.request）を組む（値が 1 つでも欠ければ組まない）
 * - 照合の期限と、依頼の送り直しの判定
 */
import { plateSentences } from "../customer/match";
import { withCustomerQuestion } from "../session/customer";
import { keptLines } from "../session/kept";
import { type Session, transition } from "../session/store";
import { type CustomerQuery, type InvoiceRequest, InvoiceRequest as InvoiceRequestSchema, type ToFactory } from "./schema";

/** 照合の答えを待つ秒数。過ぎたら客の質問に戻る（§4）。事務所にも同じ秒数で答えを打ち切ってもらう。 */
export const QUERY_TIMEOUT_SEC = 10;
/** 依頼を置けなかったときの送り直しの間隔と、あきらめるまでの時間（§4）。 */
export const RESEND_EVERY_SEC = 30;
export const RESEND_FOR_SEC = 60 * 60;

type Where = CustomerQuery["from"];

/** 4 桁を含む文があれば、その原文だけで問い合わせを組む。無ければ null。 */
export function buildCustomerQuery(x: { id: string; sessionId: string; texts: string[]; from: Where; now: Date }): CustomerQuery | null {
  const { said, plate4 } = plateSentences(x.texts);
  if (said.length === 0) return null;
  return {
    v: 1,
    id: x.id,
    sessionId: x.sessionId,
    sentAt: x.now.toISOString(),
    kind: "customer.query",
    said,
    plate4,
    from: x.from,
    ttlSec: QUERY_TIMEOUT_SEC,
  };
}

/** 問い合わせを待っている状態（said は入れない）。 */
export const pendingQuery = (q: CustomerQuery): NonNullable<Session["customerQuery"]> => ({
  id: q.id,
  sentAt: q.sentAt,
  status: "pending",
  retryReason: null,
});

/** 照合の期限を過ぎた pending を expired にする。変わらなければ同じものを返す。 */
export function expireQuery(s: Session, now: Date): Session {
  const q = s.customerQuery;
  if (q === null || q.status !== "pending") return s;
  if (now.getTime() - Date.parse(q.sentAt) < QUERY_TIMEOUT_SEC * 1000) return s;
  return { ...s, customerQuery: { ...q, status: "expired" }, updatedAt: now.toISOString() };
}

/**
 * 置けなかった問い合わせを unreachable にする（その問い合わせを今も待っているときだけ）。
 * reason は boxMissing（共有フォルダが見えない）か writeFailed（書けない）。retryReason に残す。
 */
export function queryUnreachable(s: Session, queryId: string, now: Date, reason: "boxMissing" | "writeFailed" = "writeFailed"): Session {
  const q = s.customerQuery;
  if (q === null || q.id !== queryId || q.status !== "pending") return s;
  return { ...s, customerQuery: { ...q, status: "unreachable", retryReason: reason }, updatedAt: now.toISOString() };
}

export type Applied =
  | { accepted: true; duplicate: boolean; session: Session; label: string | null }
  | { accepted: false; why: "stale" | "unsupported"; session: Session };

const ANSWERABLE = new Set<Session["status"]>(["idle", "listening", "thinking", "drafting", "asking"]);

/**
 * 事務所の返しを作業に当てる。同じ id は 2 回目から何もしない（duplicate）。
 * 今待っていない答え（別の問い合わせ・期限切れ・承認の後）と、別の依頼の結果は stale で捨てる。
 */
export function applyToFactory(s: Session, m: ToFactory, now: Date): Applied {
  if (s.appliedIds.includes(m.id)) return { accepted: true, duplicate: true, session: s, label: null };
  const at = now.toISOString();
  const applied = (next: Session, label: string | null = null): Applied => ({
    accepted: true,
    duplicate: false,
    session: { ...next, appliedIds: [...next.appliedIds, m.id], updatedAt: at },
    label,
  });

  if (m.kind === "customer.answer") {
    const cur = expireQuery(s, now).customerQuery;
    if (cur === null || cur.id !== m.queryId || cur.status !== "pending" || !ANSWERABLE.has(s.status)) {
      return { accepted: false, why: "stale", session: s };
    }
    if (m.result.status === "retry") {
      return applied({ ...s, customerQuery: { ...cur, status: "answered", retryReason: m.result.reason } });
    }
    const decided: Session = {
      ...s,
      customer: { customerNo: m.result.customerNo, carNo: m.result.carNo },
      customerQuery: { ...cur, status: "answered", retryReason: null },
    };
    // 質問は asking のときだけ組み直す（抽出の途中なら、抽出の後に startSession が組む）
    const next = s.status === "asking" ? { ...decided, questions: withCustomerQuestion(s.questions, decided) } : decided;
    return applied(next, m.result.label);
  }

  // invoice.result
  const o = s.office;
  if (o === null || o.requestId !== m.requestId || (s.status !== "sending" && s.status !== "sent")) {
    return { accepted: false, why: "stale", session: s };
  }
  if (m.outcome !== "entered" && m.outcome !== "stopped") return { accepted: false, why: "unsupported", session: s };
  // 置けた知らせより先に結果が着いたら、置けたことにしてから進める
  const sent = s.status === "sending" ? transition({ ...s, office: { ...o, sentAt: o.sentAt ?? at } }, "sent", now) : s;
  const result = { id: m.id, outcome: m.outcome, reason: m.reason, enteredLines: m.enteredLines, at };
  return applied(transition({ ...sent, office: { ...(sent.office ?? o), result } }, m.outcome, now));
}

/** 承認済みの作業から入力の依頼を組む。客・値が 1 つでも欠ければ null（推測で埋めない）。 */
export function buildInvoiceRequest(s: Session, requestId: string, now: Date): InvoiceRequest | null {
  if (s.customer === null || s.invoice === null || s.refs === null || s.approvedAt === null) return null;
  const approve = [...s.answers].reverse().find((a) => a.action.kind === "approve");
  if (approve === undefined) return null;
  const kept = keptLines(s.refs.lines.length, s.answers);
  const quoted = (p: { recordingId: string; startSec: number; endSec: number; quote: string }) => ({
    recordingId: p.recordingId,
    startSec: p.startSec,
    endSec: p.endSec,
    quote: p.quote,
  });
  const lines = s.invoice.lines.map((l, i) => {
    const answered = s.answers.some((a) => a.action.kind === "setUnitPrice" && a.lineIndex === kept[i]);
    const from: "ledger" | "spoken" | "answer" = answered
      ? "answer"
      : l.ledger.found && l.unitPrice === l.ledger.price
        ? "ledger"
        : "spoken";
    return {
      item: l.item,
      qty: l.qty,
      unit: l.unit,
      unitPrice: l.unitPrice,
      amount: l.amount,
      unitPriceFrom: from,
      provenance: quoted(l.provenance),
    };
  });
  const spoken = s.candidates.find((c) => c.kind === "total" && c.taxIncluded !== true && c.value !== null);
  const r = InvoiceRequestSchema.safeParse({
    v: 1,
    id: requestId,
    sessionId: s.id,
    sentAt: now.toISOString(),
    kind: "invoice.request",
    attempt: s.office?.attempt ?? 1,
    customer: s.customer,
    approvedAt: s.approvedAt,
    approval: quoted(approve.provenance),
    lines,
    total: s.invoice.total,
    totalSpoken: spoken?.value ?? null,
  });
  return r.success ? r.data : null;
}

/** 依頼を置く前の状態: done → sending（組めなければ done → stopped・invalid）。 */
export function beginSending(s: Session, requestId: string, now: Date): { session: Session; request: InvoiceRequest | null } {
  const at = now.toISOString();
  const office = { requestId, attempt: 1, sentAt: null, firstTriedAt: at, lastTriedAt: at, lastError: null, result: null };
  const withOffice = { ...s, office };
  const request = buildInvoiceRequest(withOffice, requestId, now);
  if (request === null) {
    const result = { id: requestId, outcome: "stopped", reason: "invalid", enteredLines: 0, at };
    return { session: transition({ ...withOffice, office: { ...office, result } }, "stopped", now), request: null };
  }
  return { session: transition(withOffice, "sending", now), request };
}

/** 置けた: sending → sent。すでに進んでいれば（結果が先に着いた）そのまま。 */
export function markSent(s: Session, requestId: string, now: Date): Session {
  if (s.status !== "sending" || s.office?.requestId !== requestId) return s;
  return transition({ ...s, office: { ...s.office, sentAt: now.toISOString(), lastError: null } }, "sent", now);
}

/** 置けなかった: sending のまま、理由と時刻を残す。 */
export function markSendFailed(s: Session, requestId: string, error: string, now: Date): Session {
  if (s.status !== "sending" || s.office?.requestId !== requestId) return s;
  const at = now.toISOString();
  return { ...s, office: { ...s.office, lastError: error, lastTriedAt: at }, updatedAt: at };
}

/** 送り直す時か（sending で、前の試しから 30 秒過ぎ、最初の試しから 1 時間以内）。 */
export function shouldResend(s: Session, now: Date): boolean {
  const o = s.office;
  if (s.status !== "sending" || o === null) return false;
  const t = now.getTime();
  if (t - Date.parse(o.firstTriedAt) > RESEND_FOR_SEC * 1000) return false;
  return o.lastTriedAt === null || t - Date.parse(o.lastTriedAt) >= RESEND_EVERY_SEC * 1000;
}

/** 送り直しの前に、試した時刻を進める。 */
export function markRetrying(s: Session, now: Date): Session {
  if (s.office === null) return s;
  return { ...s, office: { ...s.office, lastTriedAt: now.toISOString() } };
}

/** 失敗の文（固定の文と種類名だけ。パス・ホスト名・中身を入れない）。 */
export function sendError(e: unknown): string {
  const kind = e instanceof Error ? e.constructor.name || e.name : typeof e;
  return `受け箱に置けませんでした（${kind}）`;
}
