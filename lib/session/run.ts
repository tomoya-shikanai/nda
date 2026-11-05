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
import { maskCustomerInfo } from "../customer/match";
import { buildCustomerQuery, pendingQuery } from "../office/flow";
import { type OfficeLink, sendQuery, submitInvoice } from "../office/link";
import { answerBase, answerSession } from "./answer";
import { customerPending, withCustomerQuestion } from "./customer";
import { isApproval } from "./approval";
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
function draft(out: Extracted, t: Transcript, ledger: LedgerEntry[], c: Pick<Session, "customerRequired" | "customer">) {
  const { candidates } = out;
  // 言い換えの言葉の行を補う（足した参照も保存する。答えの後の組み直しが同じ行を作るため）
  const refs = addAmbiguousLines(out, t, ledger);
  const invoice = assembleInvoice({ candidates, ...refs }, t, ledger);
  const questions = withCustomerQuestion(toQuestions(invoice, candidates, t, ledger), c);
  return { candidates, refs, invoice, questions };
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

/** 料金表の語（品目名・別名・言い換え）。これを含む句は伏せない。 */
const itemWordsOf = (ledger: LedgerEntry[]) => ledger.flatMap((e) => [e.item, ...e.aliases]);

const maskSegments = (t: Transcript, ledger: LedgerEntry[]): Transcript => {
  const texts = maskCustomerInfo(
    t.segments.map((g) => g.text),
    itemWordsOf(ledger),
  );
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
  const query =
    office === null || segs.length === 0
      ? null
      : buildCustomerQuery({
          id: randomUUID(),
          sessionId: id,
          texts: segs.map((g) => g.text),
          from: { recordingId: x.transcript.recordingId, startSec: segs[0].startSec, endSec: Math.max(...segs.map((g) => g.endSec)) },
          now: now(),
        });
  const transcript = maskSegments(x.transcript, x.ledger);
  let s: Session = {
    ...newSession(id, now()),
    customerRequired: office !== null,
    customerQuery: query ? pendingQuery(query) : null,
  };
  s = transition(s, "listening", now());
  s = { ...transition(s, "thinking", now()), transcript };
  await writeSession(x.dir, s);

  // 照合は抽出を待たずに置く（§9-3）。答えは reply の route が作業に当てる
  const asking = office !== null && query !== null ? sendQuery(x.dir, office, query) : Promise.resolve(true);
  const r = await extractWithCost(x.extract ?? extractInvoice, transcript, x.ledger);
  await asking;
  s = await withLatestOffice(x.dir, s);
  if (!r.ok) {
    const failed = { ...transition(s, "idle", now()), error: extractionError(r.error), extraction: r.cost };
    await writeSession(x.dir, failed);
    throw r.error;
  }
  s = { ...transition(s, "drafting", now()), ...draft(r.out, transcript, x.ledger, s), extraction: r.cost };
  await writeSession(x.dir, s);
  s = await withLatestOffice(x.dir, s);
  s = transition({ ...s, questions: withCustomerQuestion(s.questions, s) }, "asking", now());
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
  const latest = await withLatestOffice(x.dir, drafting);
  if (!r.ok) {
    const back = {
      ...transition(latest, "asking", now()),
      transcript: s.transcript,
      answers: [...s.answers, answer({ kind: "unread", reason: extractionError(r.error) })],
      extraction: r.cost,
    };
    await writeSession(x.dir, back);
    return back;
  }
  const next = transition({ ...latest, ...draft(r.out, transcript, x.ledger, latest), extraction: r.cost }, "asking", now());
  await writeSession(x.dir, next);
  return next;
}

/**
 * 質問中の作業への返事の 1 発話を当てて保存する。明細が 0 行なら作業の話の続き（continueSession）、
 * それ以外と承認の言葉は従来どおり answerSession（承認の言葉は抽出し直さない）。
 * 返事は先に名前らしい部分と 4 桁を伏せ字にする。客が未定で事務所がつながっていて、返事に 4 桁を含む文があれば、
 * その文の原文で照合を問い合わせて終わる（答えは reply の route が当てる）。承認したら、すぐ入力の依頼を受け箱に置く（§9-2）。
 */
export async function replySession(x: {
  dir: string;
  session: Session;
  utterance: Segment;
  ledger: LedgerEntry[];
  extract?: Extractor;
  now?: () => Date;
  office?: OfficeLink | null;
}): Promise<Session> {
  const now = x.now ?? (() => new Date());
  const office = x.office ?? null;
  const s = x.session;
  const utterance = { ...x.utterance, text: maskCustomerInfo([x.utterance.text], itemWordsOf(x.ledger))[0] };
  if (office !== null && s.customerRequired && customerPending(s)) {
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
  if (isEmptyDraft(s) && !isApproval(utterance.text)) return continueSession({ ...x, utterance });
  const next = answerSession(s, utterance, x.ledger, now());
  await writeSession(x.dir, next);
  if (office !== null && next.status === "done") return submitInvoice(x.dir, office, next, now());
  return next;
}
