/**
 * 文字起こしを受けて、明細と質問を作り、作業 1 件の状態を保存する（W2）。
 * 抽出の前に thinking を書くので、モニターは「考え中」を見られる。
 * 確認事項が 0 件でも asking で止める。done にするのは承認だけ（W4）。
 * 抽出の失敗は固定の文と例外の種類名だけを保存する。抽出のトークン数とかかった秒数を保存する（文の中身は入れない。事前登録の副の指標）。
 * 明細が 0 行の作業への返事は、作業の話の続きとして文字起こしに足して抽出し直す（continueSession）。
 *
 * 客（#25、docs/design/pi-office.md §5・§9-3）: 工場は客の一覧を持たない。名前らしい部分と 4 桁は一覧なしで伏せ字にしてから保存・抽出する。
 * 事務所がつながっていれば（office）、4 桁を含む文の原文だけで照合を問い合わせる。問い合わせは抽出を待たずに置き、抽出と並べて走らせる。
 * 答えは POST /api/office/reply が作業に当てるので、抽出の後に書くときは作業を読み直して、先に当たった客を消さない。
 */
import { randomUUID } from "node:crypto";
import { addAmbiguousLines } from "../invoice/ambiguous";
import { assembleInvoice } from "../invoice/build";
import type { Candidate } from "../invoice/candidates";
import { extractInvoice } from "../invoice/extract";
import { toQuestions } from "../invoice/questions";
import type { InvoiceRefs } from "../invoice/schema";
import type { LedgerEntry } from "../ledger/lookup";
import { type Segment, type Transcript, TranscriptSchema } from "../stt/types";
import { hasLedgerWord, ledgerWords, maskCustomerInfo } from "../customer/match";
import { MODEL_MAIN } from "../claude";
import { errorKind, logEvent, since } from "../log/events";
import { dropClue, getClue, setClue } from "../office/clues";
import { getLabel } from "../office/labels";
import { buildCustomerQuery, customerClue, pendingQuery } from "../office/flow";
import { modeOf, type OfficeLink, sendQuery, submitInvoice } from "../office/link";
import { answerBase, answerSession, TALK_FAILED } from "./answer";
import { customerPending, pendingCount, withCustomerQuestion } from "./customer";
import { isApproval } from "./approval";
import { withSessionLock } from "./lock";
import {
  claudeTalker,
  currentQuestion,
  cancelDecision,
  isCancelConfirm,
  setTalkSay,
  type Talker,
  type TalkOutput,
  type TalkState,
  talkSay,
  talkText,
  talkWithTimeout,
} from "./talk";
import { type Answer, type ExtractionCost, newSession, readSession, type Session, transition, writeSession } from "./store";

/** POST の body の文字起こしの形。正は lib/stt/types.ts。 */
export { TranscriptSchema };

/** 抽出の結果。usage は Messages API のトークン数（費用の記録用。偽の extractor は省いてよい）。 */
export type Extracted = { candidates: Candidate[] } & InvoiceRefs & { usage?: { inputTokens: number; outputTokens: number } };
export type Extractor = (t: Transcript, ledger: LedgerEntry[]) => Promise<Extracted>;

/** 抽出の失敗として保存する文。SDK の文（要求の中身やキーの手がかりが入り得る）は入れず、例外の種類名だけを足す。 */
export function extractionError(e: unknown): string {
  const kind = e instanceof Error ? e.constructor.name || e.name : typeof e;
  return `抽出に失敗しました（${kind}）`;
}

/** 抽出して、かかった秒数とトークン数を測る。失敗は cost つきで投げ直す。 */
async function extractWithCost(
  extract: Extractor,
  t: Transcript,
  ledger: LedgerEntry[],
): Promise<{ ok: true; out: Extracted; cost: ExtractionCost } | { ok: false; error: unknown; cost: ExtractionCost }> {
  const t0 = performance.now();
  const cost = (usage?: Extracted["usage"]): ExtractionCost => ({
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    seconds: (performance.now() - t0) / 1000,
  });
  try {
    const out = await extract(t, ledger);
    return { ok: true, out, cost: cost(out.usage) };
  } catch (error) {
    return { ok: false, error, cost: cost() };
  }
}

/** 抽出の結果から、明細・質問・参照を組む（startSession と continueSession で同じ）。 */
function draft(out: Extracted, t: Transcript, ledger: LedgerEntry[], c: Pick<Session, "customerRequired" | "customer" | "customerClueAt">) {
  const { candidates } = out;
  // 言い換えの言葉の行を補う（足した参照も保存する。答えの後の組み直しが同じ行を作るため）
  const refs = addAmbiguousLines(out, t, ledger);
  const invoice = assembleInvoice({ candidates, ...refs }, t, ledger);
  const questions = withCustomerQuestion(toQuestions(invoice, candidates, t, ledger), c);
  return { candidates, refs, invoice, questions };
}

type Drafted = ReturnType<typeof draft>;

/** 抽出の出来事を記録する（数・時間・種類名だけ。文の中身は入れない）。 */
function logExtract(
  sessionId: string,
  phase: "start" | "continue",
  extract: Extractor | undefined,
  r: Awaited<ReturnType<typeof extractWithCost>>,
  d: Drafted | null,
): void {
  const reasons: Partial<Record<string, number>> = {};
  for (const q of d?.questions ?? []) reasons[q.reason] = (reasons[q.reason] ?? 0) + 1;
  logEvent("extract", {
    sessionId,
    phase,
    model: extract === undefined || extract === extractInvoice ? MODEL_MAIN : null,
    inputTokens: r.cost.inputTokens,
    outputTokens: r.cost.outputTokens,
    ms: Math.round(r.cost.seconds * 1000),
    ok: r.ok,
    error: r.ok ? null : errorKind(r.error),
    lines: d?.invoice.lines.length ?? 0,
    confirmations: d?.invoice.confirmations.length ?? 0,
    questions: d?.questions.length ?? 0,
    questionReasons: reasons,
  });
}

/** 事務所の返しで変わる欄。抽出の後に書くとき、作業ファイルの今の値を使う（返しが先に当たっていても消さない）。 */
const OFFICE_FIELDS = ["customer", "customerQuery", "appliedIds"] as const;

async function withLatestOffice(dir: string, s: Session): Promise<Session> {
  const latest = await readSession(dir, s.id);
  if (latest === null) return s;
  const out = { ...s };
  for (const k of OFFICE_FIELDS) (out as Record<string, unknown>)[k] = latest[k];
  return out;
}

/** 伏せ字。ナンバーの文の隣でも、料金表の品目の語を含む文は残す（抽出に作業を渡す）。 */
const maskSegments = (t: Transcript, ledger: LedgerEntry[]): Transcript => {
  const texts = maskCustomerInfo(t.segments.map((g) => g.text), ledgerWords(ledger));
  return { ...t, segments: t.segments.map((g, i) => ({ ...g, text: texts[i] })) };
};

export async function startSession(x: {
  dir: string;
  transcript: Transcript;
  ledger: LedgerEntry[];
  extract?: Extractor;
  now?: () => Date;
  id?: string;
  /** 事務所。null・省略なら客の照合なし（客を聞かずに承認できる）。 */
  office?: OfficeLink | null;
}): Promise<Session> {
  const now = x.now ?? (() => new Date());
  const office = x.office ?? null;
  const id = x.id ?? randomUUID();
  const segs = x.transcript.segments;
  // 原文は問い合わせ（メモリ）にだけ入れ、作業には伏せ字にした文字起こしだけを入れる
  const instruction = office !== null && modeOf(office) === "instruction";
  const query =
    office === null || instruction || segs.length === 0
      ? null
      : buildCustomerQuery({
          id: randomUUID(),
          sessionId: id,
          texts: segs.map((g) => g.text),
          from: { recordingId: x.transcript.recordingId, startSec: segs[0].startSec, endSec: Math.max(...segs.map((g) => g.endSec)) },
          now: now(),
        });
  // 声の指示の道（#56）: 問い合わせず、話に 4 桁があればその場で手がかりとしてメモリにだけ持つ
  const clue = instruction ? customerClue(segs.map((g) => g.text)) : null;
  if (clue !== null) setClue(id, clue);
  const transcript = maskSegments(x.transcript, x.ledger);
  let s: Session = {
    ...newSession(id, now()),
    customerRequired: office !== null,
    customerClueAt: clue === null ? null : now().toISOString(),
    customerQuery: query ? pendingQuery(query) : null,
  };
  s = transition(s, "listening", now());
  s = { ...transition(s, "thinking", now()), transcript };
  await writeSession(x.dir, s);

  // 照合は抽出を待たずに置く（§9-3）。答えは reply の route が作業に当てる
  const asking = office !== null && query !== null ? sendQuery(x.dir, office, query) : Promise.resolve(true);
  const r = await extractWithCost(x.extract ?? extractInvoice, transcript, x.ledger);
  await asking;
  // 抽出の後は作業の排他の中で読み直して書く（照合の答えが先に当たっていても消さない）
  return withSessionLock(id, async () => {
    s = await withLatestOffice(x.dir, s);
    if (!r.ok) {
      logExtract(id, "start", x.extract, r, null);
      const failed = { ...transition(s, "idle", now()), error: extractionError(r.error), extraction: r.cost };
      await writeSession(x.dir, failed);
      throw r.error;
    }
    const d = draft(r.out, transcript, x.ledger, s);
    logExtract(id, "start", x.extract, r, d);
    s = { ...transition(s, "drafting", now()), ...d, extraction: r.cost };
    await writeSession(x.dir, s);
    s = transition({ ...s, questions: withCustomerQuestion(s.questions, s) }, "asking", now());
    await writeSession(x.dir, s);
    return s;
  });
}

/** 抽出で 1 行も取れなかった作業が、質問中（asking）か。返事は作業の話の続きとして扱う。答えで行を除いて 0 行になった作業は含めない。 */
export function isEmptyDraft(s: Session): boolean {
  return s.status === "asking" && s.refs !== null && s.refs.lines.length === 0 && s.invoice !== null && s.invoice.lines.length === 0;
}

/**
 * 文字起こしの後ろに返事の 1 発話を足す。返事の時刻は元の最後の終了の秒数だけ後ろにずらす（発話の順で時刻が逆転しない）。
 * recordingId は元のまま（抽出と明細の出所は 1 本の文字起こしを指す）。返事の録音の時刻は、answers の continue の offsetSec で戻せる。
 */
export function appendUtterance(t: Transcript, u: Segment): { transcript: Transcript; offsetSec: number } {
  const offsetSec = t.segments.length ? Math.max(...t.segments.map((x) => x.endSec)) : 0;
  const seg: Segment = { ...u, startSec: u.startSec + offsetSec, endSec: u.endSec + offsetSec };
  return { transcript: TranscriptSchema.parse({ ...t, segments: [...t.segments, seg] }), offsetSec };
}

/**
 * 明細が 0 行の作業への返事を、作業の話の続きとして扱う。文字起こしの後ろに返事を足し、抽出から組み直して同じ作業を更新する。
 * 状態は asking → drafting（抽出中）→ asking。done には飛ばさない（確認事項があれば質問、0 件なら承認待ち）。
 * 抽出が失敗したら文字起こしを元に戻し、答えを unread（固定の文と例外の種類名）にして asking に戻す（投げない。声で言い直せる）。
 */
export async function continueSession(x: {
  dir: string;
  session: Session;
  utterance: Segment;
  ledger: LedgerEntry[];
  extract?: Extractor;
  now?: () => Date;
}): Promise<Session> {
  const now = x.now ?? (() => new Date());
  const s = x.session;
  if (!isEmptyDraft(s) || s.transcript === null) throw new Error("明細が 0 行の質問中の作業でない");
  const { transcript, offsetSec } = appendUtterance(s.transcript, x.utterance);
  const base = answerBase(s, x.utterance, now());
  const answer = (action: Answer["action"]): Answer => ({ ...base, questionIndex: 0, lineIndex: -1, action });

  const drafting = { ...transition(s, "drafting", now()), transcript, answers: [...s.answers, answer({ kind: "continue", offsetSec })] };
  await writeSession(x.dir, drafting);

  const r = await extractWithCost(x.extract ?? extractInvoice, transcript, x.ledger);
  const latest = await withLatestOffice(x.dir, drafting);
  if (!r.ok) {
    logExtract(s.id, "continue", x.extract, r, null);
    const back = {
      ...transition(latest, "asking", now()),
      transcript: s.transcript,
      answers: [...s.answers, answer({ kind: "unread", reason: extractionError(r.error) })],
      extraction: r.cost,
    };
    await writeSession(x.dir, back);
    return back;
  }
  const d = draft(r.out, transcript, x.ledger, latest);
  logExtract(s.id, "continue", x.extract, r, d);
  const next = transition({ ...latest, ...d, extraction: r.cost }, "asking", now());
  await writeSession(x.dir, next);
  return next;
}

/**
 * 質問中の作業への返事の 1 発話を当てて保存する。明細が 0 行なら作業の話の続き（continueSession）、
 * それ以外と承認の言葉は従来どおり answerSession（承認の言葉は抽出し直さない）。
 * 返事は先に名前らしい部分と 4 桁を伏せ字にする。客が未定で事務所がつながっていて、返事に 4 桁を含む文があれば、
 * その文の原文で照合を問い合わせて終わる（答えは reply の route が当てる）。承認したら、すぐ入力の依頼を受け箱に置く（§9-2）。
 * 声の指示の道（#56）では問い合わせず、4 桁があればその場で手がかりとして受ける（replyInstruction）。承認したら声の指示を置く。
 */
type ReplyInput = {
  dir: string;
  session: Session;
  utterance: Segment;
  ledger: LedgerEntry[];
  extract?: Extractor;
  now?: () => Date;
  office?: OfficeLink | null;
  /** 会話の受け皿の Claude。省略なら本物（talk.ts）。 */
  talk?: Talker;
};

/** 作業の排他の中で作業ファイルを読み直してから当てる（同時の答え・承認で片方を消さない、依頼を 2 件出さない）。 */
export async function replySession(x: ReplyInput): Promise<Session> {
  return withSessionLock(x.session.id, async () => {
    const fresh = await readSession(x.dir, x.session.id);
    return replyLocked({ ...x, session: fresh ?? x.session });
  });
}

async function replyLocked(x: ReplyInput): Promise<Session> {
  const now = x.now ?? (() => new Date());
  const office = x.office ?? null;
  const s = x.session;
  const utterance = { ...x.utterance, text: maskCustomerInfo([x.utterance.text], ledgerWords(x.ledger))[0] };
  if (office !== null && modeOf(office) === "instruction" && s.customerRequired) {
    const r = await replyInstruction({ ...x, office }, s, utterance, now);
    if (r !== null) return r;
  }
  if (office !== null && modeOf(office) === "query" && s.customerRequired && customerPending(s)) {
    if (s.status !== "asking") throw new Error(`asking でないので答えを受けられない: ${s.status}`);
    const base = answerBase(s, utterance, now());
    const query = buildCustomerQuery({
      id: randomUUID(),
      sessionId: s.id,
      texts: [x.utterance.text],
      from: { recordingId: base.provenance.recordingId, startSec: utterance.startSec, endSec: utterance.endSec },
      now: now(),
    });
    if (query !== null) {
      const answer: Answer = {
        ...base,
        questionIndex: s.questions.findIndex((q) => q.reason === "customer"),
        lineIndex: -1,
        action: { kind: "askOffice", queryId: query.id },
      };
      const next: Session = { ...s, answers: [...s.answers, answer], customerQuery: pendingQuery(query), updatedAt: base.at };
      await writeSession(x.dir, next);
      await sendQuery(x.dir, office, query);
      return (await readSession(x.dir, s.id)) ?? next;
    }
  }
  if (isEmptyDraft(s) && !isApproval(utterance.text)) {
    const c = await continueSession({ ...x, utterance });
    // 話の続きとして抽出し直しても明細が 0 行のまま（抽出の失敗は除く）なら、会話の受け皿で受ける
    return isEmptyDraft(c) && c.answers.at(-1)?.action.kind === "continue" ? talkSession(x, c, utterance, now, null) : c;
  }
  const next = answerSession(s, utterance, x.ledger, now());
  if (talkable(s, next, utterance)) return talkSession(x, s, utterance, now, next);
  await writeSession(x.dir, next);
  if (office !== null && next.status === "done") return submitInvoice(x.dir, office, next, now());
  return next;
}

/**
 * 声の指示の道（#56）の客の扱い。当てたら作業を返し、当てるものが無ければ null（従来の answerSession に任せる）。
 * - 客が未定で、返事に 4 桁がちょうど 1 つあれば、原文の手がかりをメモリにだけ持ち、確認事項の客を消す（答えは customerClue。原文は残さない）。
 * - 手がかりを受けたのに承認の時にメモリから消えていたら（再起動）、承認せずに客の質問へ戻す（送らない）。
 */
async function replyInstruction(x: ReplyInput, s: Session, utterance: Segment, now: () => Date): Promise<Session | null> {
  if (s.status !== "asking") return null;
  const base = answerBase(s, utterance, now());
  if (customerPending(s)) {
    const clue = customerClue([x.utterance.text]);
    if (clue === null) return null;
    setClue(s.id, clue);
    const answer: Answer = {
      ...base,
      questionIndex: s.questions.findIndex((q) => q.reason === "customer"),
      lineIndex: -1,
      action: { kind: "customerClue" },
    };
    const decided: Session = { ...s, customerClueAt: base.at, answers: [...s.answers, answer], updatedAt: base.at };
    const next = { ...decided, questions: withCustomerQuestion(s.questions, decided) };
    await writeSession(x.dir, next);
    // 明細が 0 行で、同じ返事に作業も言っていれば（「仮田さん、1111。脱着4本。」）、続けて作業の話として抽出する
    if (isEmptyDraft(next) && hasLedgerWord(utterance.text, ledgerWords(x.ledger))) return continueSession({ ...x, session: next, utterance });
    return next;
  }
  if (s.customerClueAt !== null && s.customer === null && getClue(s.id) === null && isApproval(utterance.text)) {
    const lost: Session = { ...s, customerClueAt: null, updatedAt: base.at };
    const next: Session = {
      ...lost,
      questions: withCustomerQuestion(s.questions, lost),
      answers: [...s.answers, { ...base, questionIndex: -1, lineIndex: -1, action: { kind: "unread", reason: CLUE_LOST } }],
    };
    await writeSession(x.dir, next);
    return next;
  }
  return null;
}

/** 会話の受け皿に回さない読めない理由（承認の言葉への返しと客の声は今のまま）。 */
const NOT_TALK = new Set(["客の声", "確認事項が残っている"]);

/** answerSession が返事を読めなかった（unread を 1 つ足しただけ）か。承認の言葉・客の声は回さない。 */
function talkable(s: Session, next: Session, utterance: Segment): boolean {
  const last = next.answers.at(-1)?.action;
  return (
    next.status === "asking" &&
    next.answers.length === s.answers.length + 1 &&
    last?.kind === "unread" &&
    !NOT_TALK.has(last.reason) &&
    !isApproval(utterance.text) &&
    utterance.speaker !== "customer"
  );
}

/** 会話の受け皿に渡す今の状態（客の中身・名前・ナンバーは入れない）。 */
function talkState(s: Session): TalkState {
  return {
    lines: (s.invoice?.lines ?? []).map((l) => ({ item: l.item, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, amount: l.amount })),
    total: s.invoice?.total ?? null,
    confirmations: s.invoice?.confirmations.length ?? 0,
    question: currentQuestion(s),
    customerReceived: s.customer !== null || s.customerClueAt !== null,
    awaitingApproval: s.invoice !== null && pendingCount(s) === 0,
  };
}

/**
 * 読めなかった返事を Claude で意図だけ読み、コードが声の文を作る（talk.ts）。答えは talk（意図だけ）。状態は asking のまま。
 * cancel は取り消しの合図があり打ち消しが無いときだけ作業を idle に閉じる（確定・送信はしない）。迷ったら asking のまま聞き返し、
 * 次の返事が「やめる」なら閉じる。
 * Claude の失敗・期限切れは、今の「もう一度お願いします。…」（unread）に落とす。unread は answerSession が作った読めない答えの作業
 * （あればそれを保存して読めない理由を残す。無ければ TALK_FAILED を足す）。utterance は伏せ字の後の文。
 */
async function talkSession(x: ReplyInput, s: Session, utterance: Segment, now: () => Date, unread: Session | null): Promise<Session> {
  const t0 = performance.now();
  const base = answerBase(s, utterance, now());
  const record = (action: Answer["action"]): Answer => ({
    ...base,
    provenance: { ...base.provenance, quote: action.kind === "talk" ? "" : base.provenance.quote },
    questionIndex: s.questions.length ? 0 : -1,
    lineIndex: -1,
    action,
  });
  const close = async (answers: Answer[]) => {
    dropClue(s.id);
    const closed = transition({ ...s, answers }, "idle", now());
    await writeSession(x.dir, closed);
    return closed;
  };
  // 確かめの 1 往復: 直前が「やめますか？」の聞き返しで、返事が「やめる」「はい、やめる」なら Claude を呼ばずに閉じる
  const prior = s.answers.at(-1)?.action.kind === "continue" ? s.answers.at(-2) : s.answers.at(-1);
  if (prior?.action.kind === "talk" && prior.action.intent === "cancel" && isCancelConfirm(utterance.text)) {
    logEvent("talk", { sessionId: s.id, intent: "cancel", ms: since(t0), ok: true, error: null });
    return close([...s.answers, record({ kind: "talk", intent: "cancel" })]);
  }
  let out: TalkOutput;
  try {
    // 伏せ字の後さらに数字と客を指す語の後ろを伏せてから渡す
    out = await talkWithTimeout(x.talk ?? claudeTalker, { utterance: talkText(utterance.text), state: talkState(s) });
  } catch (e) {
    logEvent("talk", { sessionId: s.id, intent: null, ms: since(t0), ok: false, error: errorKind(e) });
    const next: Session = unread ?? { ...s, answers: [...s.answers, record({ kind: "unread", reason: TALK_FAILED })], updatedAt: base.at };
    await writeSession(x.dir, next);
    return next;
  }
  const intent = out.intent;
  logEvent("talk", { sessionId: s.id, intent, ms: since(t0), ok: true, error: null });
  const answers = [...s.answers, record({ kind: "talk", intent })];
  // 取り消しの合図があり打ち消しが無いときだけ閉じる。迷ったら閉じずに聞き返す（talkSay の cancel）
  if (intent === "cancel" && cancelDecision(utterance.text) === "close") return close(answers);
  setTalkSay(s.id, answers.length, talkSay(intent, out.reply, s, getClue(s.id), getLabel(s.id)));
  const next: Session = { ...s, answers, updatedAt: base.at };
  await writeSession(x.dir, next);
  return next;
}

/** 手がかりが消えていて承認しなかった答えの理由（画面の声が客の質問を言い直す）。 */
export const CLUE_LOST = "客の手がかりが無い";
