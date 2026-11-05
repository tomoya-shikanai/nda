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
import type { Transcript } from "../stt/types";
import { customerPending } from "./customer";

export const SESSION_STATES = ["idle", "listening", "thinking", "drafting", "asking", "done"] as const;
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
  /** 答えで客が決まった（名前と下 4 桁が一覧の同じ 1 件に合った）。id だけを残す。 */
  z.object({ kind: z.literal("setCustomer"), id: z.string() }),
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
  customerId: z.string().nullable().default(null),
});

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
  /** 決まった客の id（名前・ナンバーは保存しない。表示のときに一覧から引く）。 */
  customerId: string | null;
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
    customerId: null,
  };
}

const ALLOWED: Record<SessionStatus, readonly SessionStatus[]> = {
  idle: ["listening"],
  listening: ["thinking"],
  thinking: ["drafting", "idle"],
  drafting: ["asking"],
  asking: ["drafting", "done"],
  done: [],
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

/** done の作業は、承認されていて確認事項が 0 件であること。違えば throw（読み書きで壊れた done を通さない）。 */
function assertDone(s: Session): void {
  if (s.status !== "done") return;
  const confs: unknown = s.invoice?.confirmations;
  if (s.approved !== true || !Array.isArray(confs) || confs.length !== 0 || customerPending(s)) {
    throw new Error(`done なのに承認されていないか確認事項が残っている: ${s.id}`);
  }
}

export async function writeSession(dir: string, s: Session): Promise<void> {
  const target = fileOf(dir, s.id);
  assertDone(s);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${s.id}.json.${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
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
