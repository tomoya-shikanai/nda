/**
 * 工場側の事務所とのやりとりの、純粋な部分（docs/design/pi-office.md §4・§5・§9）。API を呼ばない、入力を書き換えない。
 * - 照合の問い合わせを組む（4 桁を含む文だけ。said は作業に入れない）
 * - 事務所の返し（customer.answer・invoice.result）を作業に当てる（二重の id・待っていない答えは当てない）
 * - 承認済みの作業から入力の依頼（invoice.request）を組む（値が 1 つでも欠ければ組まない）
 * - 照合の期限と、依頼の送り直しの判定
 * - 声の指示（estimate.instruction、#56）: 客の返事の原文から手がかりを拾い、承認済みの明細から作業の文を組む
 */
import { plateSentences } from "../customer/match";
import { withCustomerQuestion } from "../session/customer";
import { keptLines } from "../session/kept";
import { type Session, transition } from "../session/store";
import type { CustomerClue } from "./clues";
import {
  APPROVAL_WORDS,
  type CustomerQuery,
  type EstimateInstruction,
  EstimateInstruction as EstimateInstructionSchema,
  type InvoiceRequest,
  InvoiceRequest as InvoiceRequestSchema,
  type SLIP_KINDS,
  type ToFactory,
} from "./schema";

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
  // 事務所が「同じ依頼が 2 回届いた」と止めた結果は、1 回目の結果を保つ（§4）。状態を変えずに、受け取ったことだけ記録する
  if (m.outcome === "stopped" && m.reason === "duplicate" && o !== null) return applied(s);
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

// --- 声の指示（estimate.instruction、#56） ---

export type SlipKind = (typeof SLIP_KINDS)[number];

const DIGIT_FORMS: Record<string, string> = {
  "0": "0０〇零",
  "1": "1１一",
  "2": "2２二",
  "3": "3３三",
  "4": "4４四",
  "5": "5５五",
  "6": "6６六",
  "7": "7７七",
  "8": "8８八",
  "9": "9９九",
};

/** 文からナンバーの 4 桁（算用数字・全角・漢数字、間の空白と「-」も）を除く。 */
function withoutPlate(text: string, plate: string): string {
  const pat = [...plate].map((d) => `[${DIGIT_FORMS[d]}]`).join("[\\s\\-－‐]*");
  return text.replace(new RegExp(pat, "g"), " ");
}

/**
 * 客の返事の原文から手がかりを拾う。4 桁の数がちょうど 1 つの時だけ（2 つ以上は決めない。推測で選ばない）。
 * customerWords は 4 桁を含む文と直前の文から 4 桁を除いた言葉（残りが無ければ入れない）。
 */
export function customerClue(texts: string[]): CustomerClue | null {
  const { said, plate4 } = plateSentences(texts);
  if (plate4.length !== 1) return null;
  const plateNo = plate4[0];
  const words = said
    .map((t) => withoutPlate(t, plateNo).replace(/\s+/g, " ").replace(/^[\s、。,.]+|[\s、。,.]+$/g, ""))
    .filter((t) => t !== "")
    .join("、")
    .slice(0, 200);
  return words === "" ? { plateNo } : { plateNo, customerWords: words };
}

/** 承認済みの明細から作業の文（「タイヤ脱着 4本 550円、エアバルブ交換 4本 330円」）。数量・単価は明細にある値だけ。 */
export function workText(lines: { item: string; qty: number | null; unit: string | null; unitPrice: number | null }[]): string {
  return lines
    .map((l) =>
      [l.item, l.qty === null ? null : `${l.qty}${l.unit ?? ""}`, l.unitPrice === null ? null : `${l.unitPrice}円`]
        .filter((x) => x !== null)
        .join(" ")
        .replace(/[\r\n]+/g, " "),
    )
    .join("、");
}

/** 承認済みの作業と手がかりから声の指示を組む。手がかり・承認・明細が欠ければ null（推測で埋めない）。 */
export function buildEstimateInstruction(
  s: Session,
  requestId: string,
  now: Date,
  clue: CustomerClue | null,
  slipKind: SlipKind,
): EstimateInstruction | null {
  if (clue === null || s.invoice === null || s.approvedAt === null || s.invoice.lines.length === 0) return null;
  if (!s.answers.some((a) => a.action.kind === "approve")) return null;
  const r = EstimateInstructionSchema.safeParse({
    v: 1,
    id: requestId,
    sessionId: s.id,
    sentAt: now.toISOString(),
    kind: "estimate.instruction",
    attempt: s.office?.attempt ?? 1,
    approvedAt: s.approvedAt,
    approval: APPROVAL_WORDS,
    vehicle: clue.customerWords === undefined ? { plateNo: clue.plateNo } : { plateNo: clue.plateNo, customerWords: clue.customerWords },
    slipKind,
    work: workText(s.invoice.lines),
  });
  return r.success ? r.data : null;
}

/** 手がかりが無い（再起動でメモリから消えた）ので送らない理由。 */
export const NO_CLUE = "noClue";

/** 声の指示を置く前の状態: done → sending（手がかりが無ければ done → stopped・noClue、組めなければ stopped・invalid）。 */
export function beginInstruction(
  s: Session,
  requestId: string,
  now: Date,
  clue: CustomerClue | null,
  slipKind: SlipKind,
): { session: Session; instruction: EstimateInstruction | null } {
  const at = now.toISOString();
  const office = {
    requestId,
    attempt: 1,
    sentAt: null,
    firstTriedAt: at,
    lastTriedAt: at,
    lastError: null,
    result: null,
    message: "estimate.instruction" as const,
    slipKind,
  };
  const withOffice = { ...s, office };
  const instruction = buildEstimateInstruction(withOffice, requestId, now, clue, slipKind);
  if (instruction === null) {
    const result = { id: requestId, outcome: "stopped", reason: clue === null ? NO_CLUE : "invalid", enteredLines: 0, at };
    return { session: transition({ ...withOffice, office: { ...office, result } }, "stopped", now), instruction: null };
  }
  return { session: transition(withOffice, "sending", now), instruction };
}

/** 送り直しの時に手がかりが消えていた: sending → stopped・noClue。 */
export function stopNoClue(s: Session, now: Date): Session {
  if (s.status !== "sending" || s.office === null) return s;
  const at = now.toISOString();
  const result = { id: s.office.requestId, outcome: "stopped", reason: NO_CLUE, enteredLines: 0, at };
  return transition({ ...s, office: { ...s.office, result } }, "stopped", now);
}
