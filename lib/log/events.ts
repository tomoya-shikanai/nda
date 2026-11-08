/**
 * 出来事の記録（後で動きを直すための材料、docs/logging.md）。NDA_LOG_DIR があれば、その中の events-YYYY-MM-DD.jsonl（日付は機械の時刻）に 1 行ずつ足す。
 * NDA_LOG_DIR が無ければ記録しない。書き込みの失敗で本体を止めない（投げない）。
 *
 * 守り: 文字起こしの文・聞き取った言葉・客の名前・ナンバー・label・said は記録しない。品目名も記録しない。
 * 記録するのは、数・時間・種類名（閉じた enum）・id（作業 id・メッセージ id。形を確かめる）だけ。
 * 出来事ごとに形を zod で決め（strict で余計な欄を許さない）、合わなければその行を捨てて log.invalid（種類だけ）を残す。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MODEL_AUX, MODEL_MAIN } from "../claude";
import { QUESTION_REASONS } from "../invoice/questions";
import { INVOICE_OUTCOMES, INVOICE_REASONS } from "../office/schema";
import { UNREAD_REASONS } from "../session/answer";
import { SESSION_STATES } from "../session/store";

/**
 * 出来事ごとの形。store・answer が記録を import するので（循環）、最初に使う時に組む。
 */
function buildSchemas() {
  /** 作業 id・メッセージ id（UUID か英数字と - _）。 */
  const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
  /** 例外の種類名（TypeError・BoxMissingError など）。識別子の形だけ。 */
  const ErrorKind = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
  const Ms = z.number().finite().nonnegative();
  const Count = z.number().int().nonnegative();
  const Status = z.enum(SESSION_STATES);
  const QuestionReason = z.enum(QUESTION_REASONS);
  /** 答えを読めなかった理由。固定の文と、抽出の失敗（種類名は extract の出来事にある）と、それ以外。 */
  const UNREAD_CODES = [...UNREAD_REASONS, "抽出に失敗", "other"] as const;
  const UnreadCode = z.enum(UNREAD_CODES);
  const ACTION_KINDS = [
    "setQty",
    "setUnitPrice",
    "setItem",
    "confirm",
    "deny",
    "drop",
    "unrelated",
    "approve",
    "askOffice",
    "continue",
    "unread",
  ] as const;
  const RETRY_REASONS = ["none", "many", "expired", "dbUnavailable", "boxMissing", "writeFailed"] as const;

  return {
    /** 作業を作った。 */
    "session.created": z.object({ sessionId: Id, customerRequired: z.boolean() }),
    /** 状態の遷移（作業ファイルの history に足された 1 つ）。 */
    "session.transition": z.object({ sessionId: Id, from: Status.nullable(), to: Status }),
    /** 承認。作った時から承認までの ms と、答えの数。 */
    "session.approved": z.object({ sessionId: Id, msFromCreated: Ms, answers: Count }),
    /** 答えの 1 発話。答えた質問の理由の種類・操作の種類・読めなかった理由。 */
    "session.answer": z.object({
      sessionId: Id,
      questionReason: QuestionReason.nullable(),
      action: z.enum(ACTION_KINDS),
      unreadReason: UnreadCode.nullable(),
    }),
    /** 照合の問い合わせが決着した（答え・期限切れ・置けない）。 */
    "session.query": z.object({
      sessionId: Id,
      queryId: Id,
      status: z.enum(["answered", "expired", "unreachable"]),
      retryReason: z.enum(RETRY_REASONS).nullable(),
    }),
    /** 承認の後の入力の結果（事務所の返し、または依頼を組めなかった）。 */
    "session.office": z.object({
      sessionId: Id,
      requestId: Id,
      outcome: z.enum(INVOICE_OUTCOMES),
      reason: z.enum(INVOICE_REASONS).nullable(),
      enteredLines: Count,
      attempt: Count,
      msFromApproved: Ms.nullable(),
    }),
    /** 文字起こし。audioSec は WAV の長さ（WAV でなければ null）。 */
    stt: z.object({
      vendor: z.enum(["scribe", "gemini"]),
      purpose: z.enum(["start", "answer"]),
      audioSec: Ms.nullable(),
      ms: Ms,
      ok: z.boolean(),
      error: z.union([z.literal("noKey"), ErrorKind]).nullable(),
    }),
    /** 抽出。トークン数は分からなければ null。questionReasons は質問の主な理由ごとの数。 */
    extract: z.object({
      sessionId: Id,
      phase: z.enum(["start", "continue"]),
      model: z.enum([MODEL_MAIN, MODEL_AUX]).nullable(),
      inputTokens: Count.nullable(),
      outputTokens: Count.nullable(),
      ms: Ms,
      ok: z.boolean(),
      error: ErrorKind.nullable(),
      lines: Count,
      confirmations: Count,
      questions: Count,
      questionReasons: z.partialRecord(QuestionReason, Count),
    }),
    /** 受け箱に置いた（照合の問い合わせ・入力の依頼）。 */
    "office.put": z.object({
      sessionId: Id,
      message: z.enum(["customer.query", "invoice.request"]),
      messageId: Id,
      attempt: Count.nullable(),
      ms: Ms,
      ok: z.boolean(),
      error: z.enum(["boxMissing", "writeFailed", "timeout"]).nullable(),
    }),
    /** 事務所の返しを受けた。msSinceSent は置いた時から（分からなければ null）。 */
    "office.reply": z.object({
      sessionId: Id,
      messageId: Id,
      message: z.enum(["customer.answer", "invoice.result"]),
      result: z.enum(["accepted", "duplicate", "stale", "unsupported", "noSession"]),
      answer: z.enum(["found", "retry"]).nullable(),
      retryReason: z.enum(RETRY_REASONS).nullable(),
      outcome: z.enum(INVOICE_OUTCOMES).nullable(),
      msSinceSent: Ms.nullable(),
    }),
    /** 声・答えの入口が断った（作業が無い・質問中でない・聞いている間に変わった・聞き取れない・抽出の失敗）。 */
    "route.reject": z.object({
      route: z.enum(["start", "answer"]),
      sessionId: Id.nullable(),
      reason: z.enum(["notFound", "notAsking", "stale", "unheard", "extractFailed"]),
    }),
    /** 声（VOICEVOX）。 */
    tts: z.object({ ms: Ms, ok: z.boolean(), error: ErrorKind.nullable() }),
    /** 形が合わずに捨てた行（種類だけ）。 */
    "log.invalid": z.object({ of: z.string().regex(/^[a-z.]{1,40}$/) }),
  } as const;
}

type Schemas = ReturnType<typeof buildSchemas>;
export type EventKind = keyof Schemas;
export type EventFields<K extends EventKind> = z.input<Schemas[K]>;

let built: Record<string, z.ZodType> | null = null;
/** 余計な欄を許さない形（strict）。 */
function schemas() {
  built ??= Object.fromEntries(Object.entries(buildSchemas()).map(([k, v]) => [k, v.strict()]));
  return built;
}
export type LoggedEvent = { t: string; kind: EventKind } & Record<string, unknown>;

/** 記録の置き場。無ければ null（記録しない）。 */
export const logDir = (env: NodeJS.ProcessEnv = process.env): string | null => env.NDA_LOG_DIR || null;

const pad = (n: number) => String(n).padStart(2, "0");
/** 機械の時刻の日付（YYYY-MM-DD）。 */
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const eventsFile = (dir: string, d: Date) => join(dir, `events-${localDate(d)}.jsonl`);

function append(dir: string, now: Date, line: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(eventsFile(dir, now), `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** 1 行足す。NDA_LOG_DIR が無ければ何もしない。形が合わなければ捨てて log.invalid。投げない。 */
export function logEvent<K extends EventKind>(kind: K, fields: EventFields<K>, now = new Date()): void {
  const dir = logDir();
  if (dir === null) return;
  try {
    const r = schemas()[kind].safeParse(fields);
    if (r.success) append(dir, now, { t: now.toISOString(), kind, ...(r.data as Record<string, unknown>) });
    else append(dir, now, { t: now.toISOString(), kind: "log.invalid", of: kind });
  } catch {
    // 記録の失敗で本体を止めない
  }
}

/** 例外の種類名（中身の文は入れない）。 */
export function errorKind(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  const name = e.name && e.name !== "Error" ? e.name : e.constructor.name || "Error";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}

/** 経過 ms（performance.now の差）。 */
export const since = (t0: number) => Math.max(0, Math.round(performance.now() - t0));
