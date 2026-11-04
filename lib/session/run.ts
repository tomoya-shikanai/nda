/**
 * 文字起こしを受けて、明細と質問を作り、作業 1 件の状態を保存する（W2）。
 * 抽出の前に thinking を書くので、モニターは「考え中」を見られる。
 * 確認事項が 0 件でも asking で止める。done にするのは承認だけ（W4）。
 * 抽出の失敗は固定の文と例外の種類名だけを保存する。抽出のトークン数とかかった秒数を保存する（文の中身は入れない。事前登録の副の指標）。
 * 明細が 0 行の作業への返事は、作業の話の続きとして文字起こしに足して抽出し直す（continueSession）。
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
import { type Customer, identifyCustomer } from "../customer/match";
import { answerBase, answerSession } from "./answer";
import { customerPending, withCustomerQuestion } from "./customer";
import { isApproval } from "./approval";
import { type Answer, type ExtractionCost, newSession, type Session, transition, writeSession } from "./store";

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
function draft(out: Extracted, t: Transcript, ledger: LedgerEntry[], c: { customerRequired: boolean; customerId: string | null }) {
  const { candidates } = out;
  // 言い換えの言葉の行を補う（足した参照も保存する。答えの後の組み直しが同じ行を作るため）
  const refs = addAmbiguousLines(out, ledger);
  const invoice = assembleInvoice({ candidates, ...refs }, t, ledger);
  const questions = withCustomerQuestion(toQuestions(invoice, candidates, t, ledger), c);
  return { candidates, refs, invoice, questions };
}

export async function startSession(x: {
  dir: string;
  transcript: Transcript;
  ledger: LedgerEntry[];
  extract?: Extractor;
  now?: () => Date;
  id?: string;
  /** 客の一覧。null・省略なら客の照合なし。あれば名前と下 4 桁を伏せ字にしてから保存・抽出し、客が決まるまで承認させない。 */
  customers?: Customer[] | null;
}): Promise<Session> {
  const now = x.now ?? (() => new Date());
  const customers = x.customers ?? null;
  let transcript = x.transcript;
  let customer = { customerRequired: false, customerId: null as string | null };
  if (customers !== null) {
    const found = identifyCustomer(transcript.segments.map((g) => g.text), customers);
    transcript = { ...transcript, segments: transcript.segments.map((g, i) => ({ ...g, text: found.texts[i] })) };
    customer = { customerRequired: true, customerId: found.customerId };
  }
  let s: Session = { ...newSession(x.id ?? randomUUID(), now()), ...customer };
  s = transition(s, "listening", now());
  s = { ...transition(s, "thinking", now()), transcript };
  await writeSession(x.dir, s);

  const r = await extractWithCost(x.extract ?? extractInvoice, transcript, x.ledger);
  if (!r.ok) {
    const failed = { ...transition(s, "idle", now()), error: extractionError(r.error), extraction: r.cost };
    await writeSession(x.dir, failed);
    throw r.error;
  }
  s = { ...transition(s, "drafting", now()), ...draft(r.out, transcript, x.ledger, s), extraction: r.cost };
  await writeSession(x.dir, s);
  s = transition(s, "asking", now());
  await writeSession(x.dir, s);
  return s;
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
  if (!r.ok) {
    const back = {
      ...transition(drafting, "asking", now()),
      transcript: s.transcript,
      answers: [...s.answers, answer({ kind: "unread", reason: extractionError(r.error) })],
      extraction: r.cost,
    };
    await writeSession(x.dir, back);
    return back;
  }
  const next = transition({ ...drafting, ...draft(r.out, transcript, x.ledger, s), extraction: r.cost }, "asking", now());
  await writeSession(x.dir, next);
  return next;
}

/**
 * 質問中の作業への返事の 1 発話を当てて保存する。明細が 0 行なら作業の話の続き（continueSession）、
 * それ以外と承認の言葉は従来どおり answerSession（承認の言葉は抽出し直さない）。
 * 客の照合が有効な作業では、先に返事の名前と下 4 桁を伏せ字にする。客が未定で、返事が一覧の 1 件に合えば、客を決めて終わる。
 */
export async function replySession(x: {
  dir: string;
  session: Session;
  utterance: Segment;
  ledger: LedgerEntry[];
  extract?: Extractor;
  now?: () => Date;
  customers?: Customer[] | null;
}): Promise<Session> {
  const now = x.now ?? (() => new Date());
  const s = x.session;
  let utterance = x.utterance;
  if (s.customerRequired && x.customers) {
    const found = identifyCustomer([utterance.text], x.customers);
    utterance = { ...utterance, text: found.texts[0] };
    if (customerPending(s) && found.customerId !== null) {
      if (s.status !== "asking") throw new Error(`asking でないので答えを受けられない: ${s.status}`);
      const base = answerBase(s, utterance, now());
      const answer: Answer = {
        ...base,
        questionIndex: s.questions.findIndex((q) => q.reason === "customer"),
        lineIndex: -1,
        action: { kind: "setCustomer", id: found.customerId },
      };
      const decided = { ...s, customerId: found.customerId };
      const questions = withCustomerQuestion(s.questions, decided);
      const next: Session = { ...decided, answers: [...s.answers, answer], questions, updatedAt: base.at };
      await writeSession(x.dir, next);
      return next;
    }
  }
  const y = { ...x, utterance };
  if (isEmptyDraft(s) && !isApproval(utterance.text)) return continueSession(y);
  const next = answerSession(s, utterance, x.ledger, now());
  await writeSession(x.dir, next);
  return next;
}
