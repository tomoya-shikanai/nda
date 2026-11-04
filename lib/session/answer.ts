/**
 * 父の答えで確認事項を解く（W4）。純粋な関数。API を呼ばない（答えの読み取りに Claude を使わない）、入力を書き換えない。
 * 推測で埋めない: 読めない答え・単位の違う答え・金額から割り出す必要のある答えは unread にして、質問を残す。
 * price・check の確認事項は答えで消さず、必ず計算し直す（料金表と違う単価の答えは、また確認事項になる）。
 */
import type { AssembledInvoice } from "../invoice/build";
import { type Candidate, type CandidateKind, enumerateCandidates } from "../invoice/candidates";
import { checkAmounts } from "../invoice/check";
import { type Confirmation, type PricedLine, priceInvoice } from "../invoice/price";
import { type Question, type QuestionReason, reasonOf, toQuestions } from "../invoice/questions";
import { CORRECTION_CUES, COUNT_UNITS, NEGATION_CUES, resolveInvoice } from "../invoice/resolve";
import type { InvoiceLine, InvoiceRefs } from "../invoice/schema";
import type { LedgerEntry } from "../ledger/lookup";
import type { Segment, Transcript } from "../stt/types";
import { bareAnswer, isApproval, isNo, isYes } from "./approval";
import { type Answer, type Session, transition } from "./store";

type Action = Answer["action"];

const NUMBER_KINDS = new Set<CandidateKind>(["qty", "bareNumber", "unitPrice", "amount", "total"]);
const QTY_REASONS = new Set<QuestionReason>(["qty", "unit", "correction", "unparsed"]);
const SPEAKERS = new Set(["father", "customer", "son"]);

const unread = (reason: string): Action => ({ kind: "unread", reason });

/** 「数＋円」の候補（単価か、数量の付かない金額）。 */
const isYen = (c: Candidate) => c.kind === "unitPrice" || (c.kind === "amount" && c.impliedQty === undefined);

function readQty(c: Candidate, unit: string | null): Action {
  if (c.value === null) return unread("数が読めない");
  let u: string;
  if (c.kind === "qty" && c.unit === unit && unit !== null) u = unit;
  else if ((c.kind === "bareNumber" && c.unit === null) || (c.kind === "qty" && c.unit === "つ")) {
    if (unit === null) return unread("質問の単位が分からない");
    u = unit;
  } else {
    return unread("答えの単位が質問の単位と違う");
  }
  if (COUNT_UNITS.has(u) && !Number.isInteger(c.value)) return unread("数量が整数でない");
  return { kind: "setQty", value: c.value, unit: u };
}

function readPrice(c: Candidate, unit: string | null): Action {
  if (!isYen(c) || c.value === null) return unread("「数＋円」の答えでない");
  if (c.kind === "unitPrice" && c.unit !== null && c.unit !== unit) return unread("単価の単位が質問の単位と違う");
  return { kind: "setUnitPrice", value: c.value };
}

/** 答えの 1 発話を、質問 q に対する 1 つの操作として読む。読めなければ unread。 */
export function readAnswer(q: Question, line: PricedLine | undefined, utterance: Segment, ledger: LedgerEntry[]): Action {
  const t: Transcript = { recordingId: "answer", vendor: "answer", language: "ja", glossaryHint: false, segments: [{ ...utterance }] };
  const cs = enumerateCandidates(t, ledger);
  if (cs.some((c) => c.kind === "unparsedYen" || c.kind === "unparsedNumber")) return unread("数が読めない");
  const yes = isYes(utterance.text);
  const no = isNo(utterance.text);
  const bare = bareAnswer(utterance.text);
  if (!yes && !no && [...NEGATION_CUES, ...CORRECTION_CUES].some((w) => bare.includes(w))) {
    return unread("否定か言い直しの合図がある");
  }
  if (q.lineIndex < 0) return unread("行に付かない質問は画面で直す");
  if (line === undefined) return unread("質問の行が無い");

  const nums = cs.filter((c) => NUMBER_KINDS.has(c.kind));
  const unit = line.ledger.unit ?? line.unit;
  switch (q.reason) {
    case "qty":
    case "unit":
    case "unparsed":
    case "correction": {
      if (nums.length !== 1) return unread(nums.length === 0 ? "数が無い" : "数が 2 つ以上ある");
      const c = nums[0];
      if (q.reason === "correction" && isYen(c)) return readPrice(c, unit);
      return readQty(c, unit);
    }
    case "unitPrice":
      if (nums.length !== 1) return unread(nums.length === 0 ? "数が無い" : "数が 2 つ以上ある");
      return readPrice(nums[0], unit);
    case "negation":
      if (yes) return { kind: "drop" };
      if (no) return { kind: "deny" };
      return unread("はい・いいえで読めない");
    case "other":
      if (yes) return { kind: "confirm" };
      return unread("はいで読めない");
    case "ledger":
    case "total":
      return unread("人が画面で直す");
  }
}

/** 答えが消す、resolve の確認事項の理由。 */
const CLEARS: Partial<Record<Action["kind"], Set<QuestionReason>>> = {
  setQty: QTY_REASONS,
  setUnitPrice: new Set(["unitPrice", "correction"]),
  confirm: new Set(["other"]),
  deny: new Set(["negation"]),
};

/**
 * resolveInvoice の行と確認事項に答えを順に当て、assembleInvoice と同じ順で料金表と金額の照合をやり直す。
 * kept は残した行の、resolve の行の添字。
 */
export function applyAnswers(
  x: { candidates: Candidate[]; refs: InvoiceRefs },
  t: Transcript,
  ledger: LedgerEntry[],
  answers: Answer[],
): AssembledInvoice & { kept: number[] } {
  const resolved = resolveInvoice(x.refs.lines, x.candidates, t, ledger, x.refs.negations);
  const lines: InvoiceLine[] = resolved.lines.map((l) => ({ ...l }));
  const dropped = new Set<number>();
  let confs: Confirmation[] = resolved.confirmations;
  for (const a of answers) {
    const i = a.lineIndex;
    if (i < 0 || i >= lines.length || dropped.has(i)) continue;
    const act = a.action;
    if (act.kind === "setQty") lines[i] = { ...lines[i], qty: act.value, unit: act.unit };
    if (act.kind === "setUnitPrice") lines[i] = { ...lines[i], unitPrice: act.value };
    if (act.kind === "drop") dropped.add(i);
    const clears = CLEARS[act.kind];
    if (clears) confs = confs.filter((c) => !(c.lineIndex === i && clears.has(reasonOf(c))));
  }

  const kept = lines.map((_, i) => i).filter((i) => !dropped.has(i));
  const newIndex = new Map(kept.map((orig, j) => [orig, j]));
  const keptLines = kept.map((i) => lines[i]);
  const keptRefs = kept.map((i) => x.refs.lines[i]);
  const resolvedConfs = confs
    .filter((c) => c.lineIndex < 0 || newIndex.has(c.lineIndex))
    .map((c) => (c.lineIndex < 0 ? c : { ...c, lineIndex: newIndex.get(c.lineIndex) as number }));

  // ここから下は build.ts の assembleInvoice と同じ順
  const priced = priceInvoice({ lines: keptLines }, ledger);
  const byLine = (a: { lineIndex: number }, b: { lineIndex: number }) => a.lineIndex - b.lineIndex;
  const before = [...resolvedConfs, ...priced.confirmations].sort(byLine);
  const flagged = (cf: { lineIndex: number }[], i: number) => cf.some((c) => c.lineIndex === i);
  const pl = priced.lines.map((l, i) => (flagged(before, i) ? { ...l, amount: null } : l));
  const checked = checkAmounts({ lines: pl, confirmations: before, total: before.length ? null : priced.total }, keptRefs, x.candidates);
  const confirmations = [...before, ...checked].sort(byLine);
  const final = pl.map((l, i) => (l.amount !== null && flagged(checked, i) ? { ...l, amount: null } : l));
  const total = confirmations.length === 0 ? final.reduce((s, l) => s + (l.amount ?? 0), 0) : null;
  return { lines: final, confirmations, total, unused: resolved.unused, kept };
}

/** 父の答えの 1 発話を作業に当てる。入力は書き換えない。asking でなければ throw。 */
export function answerSession(s: Session, utterance: Segment, ledger: LedgerEntry[], now: Date): Session {
  if (s.status !== "asking") throw new Error(`asking でないので答えを受けられない: ${s.status}`);
  if (s.invoice === null || s.transcript === null || s.refs === null) throw new Error("明細が無いので答えを受けられない");
  const at = now.toISOString();
  const n = s.answers.length + 1;
  const speaker: Answer["provenance"]["speaker"] =
    utterance.speaker !== null && SPEAKERS.has(utterance.speaker)
      ? (utterance.speaker as "father" | "customer" | "son")
      : "unknown";
  const base: Omit<Answer, "questionIndex" | "lineIndex" | "action"> = {
    at,
    provenance: {
      recordingId: `${s.id}#answer-${n}`,
      startSec: utterance.startSec,
      endSec: utterance.endSec,
      speaker,
      quote: utterance.text,
    },
    source: "answer",
  };

  if (isApproval(utterance.text)) {
    if (s.invoice.confirmations.length === 0) {
      const answers: Answer[] = [...s.answers, { ...base, questionIndex: -1, lineIndex: -1, action: { kind: "approve" } }];
      return transition({ ...s, answers, approved: true, approvedAt: at }, "done", now);
    }
    const answers: Answer[] = [
      ...s.answers,
      { ...base, questionIndex: -1, lineIndex: -1, action: unread("確認事項が残っている") },
    ];
    return { ...s, answers, updatedAt: at };
  }

  const x = { candidates: s.candidates, refs: s.refs };
  const q = s.questions[0];
  if (q === undefined) {
    const answers: Answer[] = [...s.answers, { ...base, questionIndex: -1, lineIndex: -1, action: unread("聞いている質問が無い") }];
    return { ...s, answers, updatedAt: at };
  }
  const { kept } = applyAnswers(x, s.transcript, ledger, s.answers);
  const line = q.lineIndex >= 0 ? s.invoice.lines[q.lineIndex] : undefined;
  const action = readAnswer(q, line, utterance, ledger);
  const lineIndex = q.lineIndex >= 0 ? (kept[q.lineIndex] ?? -1) : -1;
  const answers: Answer[] = [...s.answers, { ...base, questionIndex: 0, lineIndex, action }];
  if (action.kind === "unread") return { ...s, answers, updatedAt: at };

  const drafting = transition({ ...s, answers }, "drafting", now);
  const r = applyAnswers(x, s.transcript, ledger, answers);
  const invoice: AssembledInvoice = { lines: r.lines, confirmations: r.confirmations, total: r.total, unused: r.unused };
  const questions = toQuestions(invoice, s.candidates, s.transcript, ledger);
  return transition({ ...drafting, invoice, questions }, "asking", now);
}
