/**
 * 作業 1 件の状態を JSON ファイルに保存する（#22 は libSQL の前に JSON ファイルで進める）。
 * 書き込みは同じフォルダの一時ファイルに書いてから rename するので、途中で落ちても元のファイルは壊れない。
 * 状態の並びはここが正。app/monitor/states.ts はこちらを import する向きにする（置き換えは W3）。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AssembledInvoice } from "../invoice/build";
import type { Candidate } from "../invoice/candidates";
import type { Question } from "../invoice/questions";
import type { InvoiceRefs } from "../invoice/schema";
import { Provenance } from "../karte/schema";
import { logDir } from "../log/events";
import { logSessionChange } from "../log/session";
import type { Transcript } from "../stt/types";
import { customerPending } from "./customer";

/**
 * done（承認した瞬間）の後ろは事務所への入力（docs/design/pi-office.md §5）: sending（受け箱に置いている・送り直し中）→ sent（置けた。結果待ち）
 * → entered（保存の手前まで入った）| stopped（事務所で止まった。または依頼を組めなかった）。
 */
export const SESSION_STATES = [
  "idle",
  "listening",
  "thinking",
  "drafting",
  "asking",
  "done",
  "sending",
  "sent",
  "entered",
  "stopped",
] as const;
/** 承認の後の状態（承認済み・確認事項 0 件・客が決まっていること）。 */
export const APPROVED_STATES: readonly SessionStatus[] = ["done", "sending", "sent", "entered", "stopped"];
export const SessionStatus = z.enum(SESSION_STATES);
export type SessionStatus = (typeof SESSION_STATES)[number];

export const AnswerAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("setQty"), value: z.number(), unit: z.string() }),
  z.object({ kind: z.literal("setUnitPrice"), value: z.number() }),
  /** 言い換えの言葉の行に、父が選んだ料金表の品目（正式名）。 */
  z.object({ kind: z.literal("setItem"), item: z.string() }),
  z.object({ kind: z.literal("confirm") }),
  z.object({ kind: z.literal("deny") }),
  z.object({ kind: z.literal("drop") }),
  /** 「X は何の数ですか」に「関係ない」。その行の使われない数の確認事項を解く。 */
  z.object({ kind: z.literal("unrelated") }),
  z.object({ kind: z.literal("approve") }),
  /** 返事の 4 桁を含む文で、事務所に客の照合を問い合わせた（原文は残さない。queryId だけ）。 */
  z.object({ kind: z.literal("askOffice"), queryId: z.string() }),
  /** 声の指示の道（#56）で、返事の 4 桁を客の手がかりとして受けた（原文も 4 桁も残さない。手がかりはメモリにだけある）。 */
  z.object({ kind: z.literal("customerClue") }),
  /**
   * 明細が 0 行の作業への返事を、作業の話の続きとして文字起こしの後ろに足して抽出し直した（run.ts の continueSession）。
   * offsetSec は足した発話を後ろにずらした秒数。文字起こしの時刻 − offsetSec が、返事の録音（provenance.recordingId）の時刻。
   */
  z.object({ kind: z.literal("continue"), offsetSec: z.number() }),
  z.object({ kind: z.literal("unread"), reason: z.string() }),
]);
export type AnswerAction = z.infer<typeof AnswerAction>;

export const Answer = z.object({
  at: z.string(),
  questionIndex: z.number().int(),
  /** resolveInvoice の行の添字。答えで行を除く前の並び。 */
  lineIndex: z.number().int(),
  provenance: Provenance,
  source: z.literal("answer"),
  action: AnswerAction,
});
export type Answer = z.infer<typeof Answer>;

const HistoryEntry = z.object({ status: SessionStatus, at: z.string() });

/** 中身の形は各モジュールが正。ここでは null か配列・オブジェクトかだけを確かめる。 */
const AnyObject = z.record(z.string(), z.unknown());

/** 抽出の費用の記録（文の中身は入れない）。トークン数は分からなければ null。 */
export const ExtractionCost = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  seconds: z.number().nonnegative(),
});
export type ExtractionCost = z.infer<typeof ExtractionCost>;

const SessionSchema = z.object({
  id: z.string(),
  status: SessionStatus,
  createdAt: z.string(),
  updatedAt: z.string(),
  history: z.array(HistoryEntry),
  transcript: AnyObject.nullable(),
  candidates: z.array(z.unknown()),
  refs: AnyObject.nullable(),
  invoice: AnyObject.nullable(),
  questions: z.array(z.unknown()),
  answers: z.array(Answer),
  approved: z.boolean(),
  approvedAt: z.string().nullable(),
  error: z.string().nullable(),
  /** 前の版のファイルには無いので、無ければ null。 */
  extraction: ExtractionCost.nullable().default(null),
  /** 前の版のファイルには無いので、無ければ客の照合なし。 */
  customerRequired: z.boolean().default(false),
  customer: z.object({ customerNo: z.string(), carNo: z.string() }).nullable().default(null),
  customerClueAt: z.string().nullable().default(null),
  customerQuery: z
    .object({
      id: z.string(),
      sentAt: z.string(),
      status: z.enum(["pending", "answered", "expired", "unreachable"]),
      retryReason: z.string().nullable(),
    })
    .nullable()
    .default(null),
  office: z
    .object({
      requestId: z.string(),
      attempt: z.number().int(),
      sentAt: z.string().nullable(),
      firstTriedAt: z.string(),
      lastTriedAt: z.string().nullable(),
      lastError: z.string().nullable(),
      result: z
        .object({ id: z.string(), outcome: z.string(), reason: z.string().nullable(), enteredLines: z.number(), at: z.string() })
        .nullable(),
      message: z.enum(["invoice.request", "estimate.instruction"]).optional(),
      slipKind: z.enum(["invoice", "estimate"]).optional(),
    })
    .nullable()
    .default(null),
  appliedIds: z.array(z.string()).default([]),
});

export type CustomerQueryState = {
  id: string;
  sentAt: string;
  status: "pending" | "answered" | "expired" | "unreachable";
  /** retry の理由（none・many・expired・dbUnavailable）。found なら null。 */
  retryReason: string | null;
};

export type OfficeState = {
  /** 依頼のメッセージの id。送り直しても同じ（事務所が二重を止める鍵）。 */
  requestId: string;
  attempt: number;
  /** 受け箱に置けた時刻。置けていなければ null。 */
  sentAt: string | null;
  firstTriedAt: string;
  lastTriedAt: string | null;
  /** 置けなかった理由（固定の文と種類名だけ）。 */
  lastError: string | null;
  result: { id: string; outcome: string; reason: string | null; enteredLines: number; at: string } | null;
  /** 置いたメッセージの種類。無ければ invoice.request（前の版）。 */
  message?: "invoice.request" | "estimate.instruction";
  /** 声の指示の伝票の種類（送り直しでも同じ値を使う）。 */
  slipKind?: "invoice" | "estimate";
};

export type Session = {
  id: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  history: { status: SessionStatus; at: string }[];
  transcript: Transcript | null;
  candidates: Candidate[];
  /** モデルの参照。答えの後の組み直しに使う。 */
  refs: InvoiceRefs | null;
  invoice: AssembledInvoice | null;
  questions: Question[];
  answers: Answer[];
  approved: boolean;
  approvedAt: string | null;
  error: string | null;
  /** 抽出の費用（トークン数とかかった秒数）。抽出の前は null。 */
  extraction: ExtractionCost | null;
  /** 客の照合が有効か（作業を作ったときに一覧があったか）。true なら客が決まるまで承認できない。 */
  customerRequired: boolean;
  /** 決まった客。番号だけ（label は画面のためにメモリにだけ持つ。lib/office/labels.ts）。 */
  customer: { customerNo: string; carNo: string } | null;
  /**
   * 声の指示の道（#56）で客の手がかり（4 桁）を受けた時刻。手がかりの中身はメモリにだけ持つ（lib/office/clues.ts）。
   * これがあれば客は決まったものとして扱う（客と車は事務所が DB で決める）。
   */
  customerClueAt: string | null;
  /** 今の照合の問い合わせ。said（原文）は入れない。 */
  customerQuery: CustomerQueryState | null;
  /** 承認後の入力の依頼と結果。 */
  office: OfficeState | null;
  /** 当てた事務所のメッセージの id（二重に届いたときの判定）。 */
  appliedIds: string[];
};

/** 形を確かめて Session として返す。不正なら throw。 */
export function parseSession(v: unknown): Session {
  return SessionSchema.parse(v) as unknown as Session;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function assertId(id: string): void {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new Error(`session id が不正: ${JSON.stringify(id)}`);
  }
}

export function newSession(id: string, now: Date): Session {
  assertId(id);
  const at = now.toISOString();
  return {
    id,
    status: "idle",
    createdAt: at,
    updatedAt: at,
    history: [{ status: "idle", at }],
    transcript: null,
    candidates: [],
    refs: null,
    invoice: null,
    questions: [],
    answers: [],
    approved: false,
    approvedAt: null,
    error: null,
    extraction: null,
    customerRequired: false,
    customer: null,
    customerClueAt: null,
    customerQuery: null,
    office: null,
    appliedIds: [],
  };
}

const ALLOWED: Record<SessionStatus, readonly SessionStatus[]> = {
  idle: ["listening"],
  listening: ["thinking"],
  thinking: ["drafting", "idle"],
  drafting: ["asking"],
  asking: ["drafting", "done"],
  done: ["sending", "stopped"],
  sending: ["sent", "stopped"],
  sent: ["entered", "stopped"],
  entered: [],
  stopped: [],
};

/** 状態を進める。入力は書き換えない。許されない遷移と、未承認の asking→done は throw。 */
export function transition(s: Session, to: SessionStatus, now: Date): Session {
  if (!ALLOWED[s.status].includes(to)) {
    throw new Error(`許されない遷移: ${s.status} → ${to}`);
  }
  if (s.status === "asking" && to === "done") {
    if (s.approved !== true) throw new Error("承認されていないので done にできない");
    if (s.invoice === null || s.invoice.confirmations.length !== 0) {
      throw new Error("確認事項が残っているので done にできない");
    }
    if (customerPending(s)) throw new Error("お客様が決まっていないので done にできない");
  }
  const at = now.toISOString();
  return { ...s, status: to, updatedAt: at, history: [...s.history, { status: to, at }] };
}

function fileOf(dir: string, id: string): string {
  assertId(id);
  return join(dir, `${id}.json`);
}

/** 承認の後の作業は、承認されていて確認事項が 0 件で客が決まっていること。違えば throw（読み書きで壊れた done を通さない）。 */
function assertDone(s: Session): void {
  if (!APPROVED_STATES.includes(s.status)) return;
  const confs: unknown = s.invoice?.confirmations;
  if (s.approved !== true || !Array.isArray(confs) || confs.length !== 0 || customerPending(s)) {
    throw new Error(`done なのに承認されていないか確認事項が残っている: ${s.id}`);
  }
}

/** 記録が有効なときだけ、書く前の作業を読む（差を出来事にする）。読めなければ undefined（差を記録しない）。 */
async function previousForLog(file: string): Promise<Session | null | undefined> {
  if (logDir() === null) return undefined;
  try {
    return parseSession(JSON.parse(await readFile(file, "utf8")));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

export async function writeSession(dir: string, s: Session): Promise<void> {
  const target = fileOf(dir, s.id);
  assertDone(s);
  const prev = await previousForLog(target);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${s.id}.json.${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  if (prev !== undefined) logSessionChange(prev, s);
}

export async function readSession(dir: string, id: string): Promise<Session | null> {
  const file = fileOf(dir, id);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const s = parseSession(JSON.parse(text));
  // 読み込みで壊れたファイルを受け入れない
  if (s.id !== id) throw new Error(`session のファイル名と中の id が違う: ${id}`);
  assertDone(s);
  return s;
}

/** dir の *.json のうち updatedAt が最新のもの。.tmp は読まない。dir が無い・空なら null。 */
export async function latestSession(dir: string): Promise<Session | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let best: Session | null = null;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!ID_RE.test(id)) continue;
    const s = await readSession(dir, id);
    if (s && (best === null || Date.parse(s.updatedAt) > Date.parse(best.updatedAt))) best = s;
  }
  return best;
}

export function sessionDir(): string {
  return process.env.NDA_SESSION_DIR || join("data", "sessions");
}
