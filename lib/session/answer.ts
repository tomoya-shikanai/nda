/**
 * 父の答えで確認事項を解く（W4）。純粋な関数。API を呼ばない（答えの読み取りに Claude を使わない）、入力を書き換えない。
 * 推測で埋めない: 質問の種類ごとに受け取れる答えの形を決め、その形を取り除いた後に余計な語が残れば unread にして、質問を残す。
 * 取り除いてよいのは、句読点・空白、決まった前置き・付け足し（approval.ts）、質問が名指しした品目の語（父が言った語・正式名・別名）だけ。
 * price・check の確認事項は答えで消さず、必ず計算し直す（料金表と違う単価の答えは、また確認事項になる）。
 */
import { type AssembledInvoice, mergeConfirmations } from "../invoice/build";
import { type Candidate, type CandidateKind, enumerateCandidates, normalizeText } from "../invoice/candidates";
import { checkAmounts } from "../invoice/check";
import { type Confirmation, type PricedLine, priceInvoice } from "../invoice/price";
import {
  isUnusedNumber,
  type Question,
  type QuestionReason,
  reasonOf,
  relatedCandidates,
  toQuestions,
  unusedNumberTexts,
} from "../invoice/questions";
import { CORRECTION_CUES, COUNT_UNITS, NEGATION_CUES, resolveInvoice } from "../invoice/resolve";
import type { InvoiceLine, InvoiceRefs } from "../invoice/schema";
import { choicesOf, findEntry, itemKey, type LedgerEntry } from "../ledger/lookup";
import type { Segment, Transcript } from "../stt/types";
import { bareAnswer, isApproval, isNo, isUnrelated, isYes, onlyValue } from "./approval";
import { pendingCount, withCustomerQuestion } from "./customer";
import { keptLines } from "./kept";
import { type Answer, type Session, transition } from "./store";

type Action = Answer["action"];

const NUMBER_KINDS = new Set<CandidateKind>(["qty", "bareNumber", "unitPrice", "amount", "total"]);
const QTY_REASONS = new Set<QuestionReason>(["qty", "unit", "correction", "unparsed"]);
const SPEAKERS = new Set(["father", "customer", "son"]);

/** 答えを読めなかった理由（固定の文）。記録（lib/log/events.ts）はこの中の文だけを残す。 */
export const UNREAD_REASONS = [
  "客の声",
  "確認事項が残っている",
  "聞いている質問が無い",
  "お客様が分からない",
  "数が読めない",
  "数が無い",
  "数が 2 つ以上ある",
  "数量が整数でない",
  "質問の単位が分からない",
  "答えの単位が質問の単位と違う",
  "単価の単位が質問の単位と違う",
  "「数＋円」の答えでない",
  "言い直しの質問に数量で答えていない",
  "質問に出た値でない",
  "どの単位の数か分からない",
  "選択肢が分からない",
  "選択肢の品目の語が無い",
  "選択肢の品目の語が 2 つ以上ある",
  "答えに余計な語がある",
  "否定か言い直しの合図がある",
  "行に付かない質問は画面で直す",
  "質問の行が無い",
  "「関係ない」で読めない",
  "はい・いいえで読めない",
  "はいで読めない",
  "人が画面で直す",
] as const;
export type UnreadReason = (typeof UNREAD_REASONS)[number];

const unread = (reason: UnreadReason): Action => ({ kind: "unread", reason });

/** 「数＋円」の候補（単価か、数量の付かない金額）。 */
const isYen = (c: Candidate) => c.kind === "unitPrice" || (c.kind === "amount" && c.impliedQty === undefined);

/** 単位の無い数（「4」「4つ」）。質問の単位で読む。 */
const unitless = (c: Candidate) => (c.kind === "bareNumber" && c.unit === null) || (c.kind === "qty" && c.unit === "つ");

/** 質問が名指しした品目の語（行の品目、料金表の正式名と別名）。正規化後。 */
function itemWords(line: PricedLine, ledger: LedgerEntry[]): string[] {
  const e = findEntry(ledger, line.item);
  return [...new Set([line.item, ...(e ? [e.item, ...e.aliases] : [])].map(normalizeText))];
}

function readQty(c: Candidate, unit: string | null): Action {
  if (c.value === null) return unread("数が読めない");
  let u: string;
  if (c.kind === "qty" && c.unit === unit && unit !== null) u = unit;
  else if (unitless(c)) {
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

/**
 * 言い直しの質問（「4本と2本のどちらですか」「4本で合っていますか」）への答え。
 * 質問に出た数量の値のどちらか 1 つ（数＋単位か数だけ）だけを受け取る。単価・金額や、質問に出ない値は unread。
 */
function readChoice(c: Candidate, choices: { value: number; unit: string | null }[], unit: string | null): Action {
  if (c.value === null) return unread("数が読めない");
  if (c.kind !== "qty" && c.kind !== "bareNumber") return unread("言い直しの質問に数量で答えていない");
  const unitOf = (x: { unit: string | null }) => (x.unit === null || x.unit === "つ" ? unit : x.unit);
  const hits = choices.filter((x) => x.value === c.value && (unitless(c) || unitOf(x) === c.unit));
  const units = [...new Set(hits.map(unitOf))];
  if (hits.length === 0) return unread("質問に出た値でない");
  if (units.length !== 1 || units[0] === null) return unread("どの単位の数か分からない");
  const u = units[0];
  if (COUNT_UNITS.has(u) && !Number.isInteger(c.value)) return unread("数量が整数でない");
  return { kind: "setQty", value: c.value, unit: u };
}

/**
 * 言い換えの言葉の質問（「タイヤ交換は、脱着ですか、組替ですか」）への答え。選択肢の正式名か別名（ほかの品目と共有しない語）が
 * ちょうど 1 つ出て、その前後に許した語（前置き・付け足し）しか無いときだけ、その品目にする。
 */
function readItemChoice(text: string, line: PricedLine, ledger: LedgerEntry[]): Action {
  const choices = choicesOf(ledger, line.item);
  if (choices.length < 2) return unread("選択肢が分からない");
  const n = normalizeText(text);
  const shared = (w: string) => ledger.filter((e) => itemKey(e.item) === itemKey(w) || e.aliases.some((a) => itemKey(a) === itemKey(w))).length > 1;
  const hits: { entry: LedgerEntry; start: number; end: number }[] = [];
  for (const e of choices) {
    const words = [e.item, ...e.aliases].map(normalizeText).filter((w) => w !== "" && !shared(w));
    // 長い語を先に（「タイヤ脱着」の中の「脱着」を別に数えない）
    const taken: { start: number; end: number }[] = [];
    for (const w of [...new Set(words)].sort((a, b) => b.length - a.length)) {
      for (let at = n.indexOf(w); at >= 0; at = n.indexOf(w, at + 1)) {
        const r = { start: at, end: at + w.length };
        if (taken.some((x) => r.start < x.end && x.start < r.end)) continue;
        taken.push(r);
      }
    }
    for (const r of taken) hits.push({ entry: e, ...r });
  }
  if (hits.length === 0) return unread("選択肢の品目の語が無い");
  if (hits.length > 1) return unread("選択肢の品目の語が 2 つ以上ある");
  if (!onlyValue(text, hits[0], [])) return unread("答えに余計な語がある");
  return { kind: "setItem", item: hits[0].entry.item };
}

/**
 * 答えの 1 発話を、質問 q に対する 1 つの操作として読む。読めなければ unread。
 * candidates は作業の候補（言い直しの質問に出た値を引くのに使う。無ければ言い直しは行の数量だけを受ける）。
 */
export function readAnswer(
  q: Question,
  line: PricedLine | undefined,
  utterance: Segment,
  ledger: LedgerEntry[],
  candidates: Candidate[] = [],
): Action {
  const t: Transcript = { recordingId: "answer", vendor: "answer", language: "ja", glossaryHint: false, segments: [{ ...utterance }] };
  const cs = enumerateCandidates(t, ledger);
  if (cs.some((c) => c.kind === "unparsedYen" || c.kind === "unparsedNumber")) return unread("数が読めない");
  const yes = isYes(utterance.text);
  const no = isNo(utterance.text);
  const unrelated = isUnrelated(utterance.text);
  const bare = bareAnswer(utterance.text);
  if (!yes && !no && !unrelated && [...NEGATION_CUES, ...CORRECTION_CUES].some((w) => bare.includes(w))) {
    return unread("否定か言い直しの合図がある");
  }
  if (q.lineIndex < 0) return unread("行に付かない質問は画面で直す");
  if (line === undefined) return unread("質問の行が無い");

  const nums = cs.filter((c) => NUMBER_KINDS.has(c.kind));
  const unit = line.ledger.unit ?? line.unit;
  /** 数がちょうど 1 つで、その数の前後に許した語しか無いときだけ、その数を read に渡す。 */
  const single = (read: (c: Candidate) => Action): Action => {
    if (nums.length !== 1) return unread(nums.length === 0 ? "数が無い" : "数が 2 つ以上ある");
    if (!onlyValue(utterance.text, nums[0], itemWords(line, ledger))) return unread("答えに余計な語がある");
    return read(nums[0]);
  };

  switch (q.reason) {
    case "qty":
    case "unit":
    case "unparsed":
      return single((c) => readQty(c, unit));
    case "correction": {
      const mine = q.confirmations.filter((c) => reasonOf(c) === "correction");
      if (unusedNumberTexts(line, mine, candidates).length > 0) {
        // 「脱着は4本ですか。2個は何の数ですか」: 数では解かない。決まった語で、その数を関係なしとして解く
        return unrelated ? { kind: "unrelated" } : unread("「関係ない」で読めない");
      }
      const choices = relatedCandidates(mine, candidates)
        .filter((x): x is Candidate & { value: number } => (x.kind === "qty" || x.kind === "bareNumber") && x.value !== null)
        .map((x) => ({ value: x.value, unit: x.unit }));
      if (choices.length === 0 && line.qty !== null) choices.push({ value: line.qty, unit: line.unit });
      return single((c) => readChoice(c, choices, unit));
    }
    case "unitPrice":
      return single((c) => readPrice(c, unit));
    case "choice":
      return readItemChoice(utterance.text, line, ledger);
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
    case "customer":
      return unread("お客様が分からない");
  }
}

/** 答えが消す、resolve の確認事項の理由。単価の答えは数量・言い直しを消さない。 */
const CLEARS: Partial<Record<Action["kind"], Set<QuestionReason>>> = {
  setQty: QTY_REASONS,
  setUnitPrice: new Set(["unitPrice"]),
  // 言い換えの確認事項は料金表の照らし直し（price.ts）で消える。resolve の確認事項は消さない
  setItem: new Set(),
  confirm: new Set(["other"]),
  deny: new Set(["negation"]),
};

/** 答えが消す確認事項か。unrelated は使われない数の確認事項だけを消す。 */
function clears(act: Action, c: Confirmation): boolean {
  if (act.kind === "unrelated") return reasonOf(c) === "correction" && isUnusedNumber(c);
  return CLEARS[act.kind]?.has(reasonOf(c)) ?? false;
}

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
  const kept = keptLines(lines.length, answers);
  const live = new Set(kept);
  let confs: Confirmation[] = resolved.confirmations;
  for (const a of answers) {
    const i = a.lineIndex;
    if (!live.has(i) || a.action.kind === "drop") continue;
    const act = a.action;
    if (act.kind === "setQty") lines[i] = { ...lines[i], qty: act.value, unit: act.unit };
    if (act.kind === "setUnitPrice") lines[i] = { ...lines[i], unitPrice: act.value };
    if (act.kind === "setItem") lines[i] = { ...lines[i], item: act.item };
    confs = confs.filter((c) => !(c.lineIndex === i && clears(act, c)));
  }

  const newIndex = new Map(kept.map((orig, j) => [orig, j]));
  const keptLinesOut = kept.map((i) => lines[i]);
  const keptRefs = kept.map((i) => x.refs.lines[i]);
  const resolvedConfs = confs
    .filter((c) => c.lineIndex < 0 || newIndex.has(c.lineIndex))
    .map((c) => (c.lineIndex < 0 ? c : { ...c, lineIndex: newIndex.get(c.lineIndex) as number }));

  // ここから下は build.ts の assembleInvoice と同じ順
  const priced = priceInvoice({ lines: keptLinesOut }, ledger);
  const before = mergeConfirmations(resolvedConfs, priced.confirmations);
  const flagged = (cf: { lineIndex: number }[], i: number) => cf.some((c) => c.lineIndex === i);
  const pl = priced.lines.map((l, i) => (flagged(before, i) ? { ...l, amount: null } : l));
  const checked = checkAmounts({ lines: pl, confirmations: before, total: before.length ? null : priced.total }, keptRefs, x.candidates);
  const confirmations = mergeConfirmations(before, checked);
  const final = pl.map((l, i) => (l.amount !== null && flagged(checked, i) ? { ...l, amount: null } : l));
  const total = confirmations.length === 0 ? final.reduce((s, l) => s + (l.amount ?? 0), 0) : null;
  return { lines: final, confirmations, total, unused: resolved.unused, kept };
}

/** 答えの記録の共通部分。出所は作業の n 番目の答えの録音（`<id>#answer-<n>`）の時刻と言葉そのまま。 */
export function answerBase(s: Session, utterance: Segment, now: Date): Omit<Answer, "questionIndex" | "lineIndex" | "action"> {
  const speaker: Answer["provenance"]["speaker"] =
    utterance.speaker !== null && SPEAKERS.has(utterance.speaker)
      ? (utterance.speaker as "father" | "customer" | "son")
      : "unknown";
  return {
    at: now.toISOString(),
    provenance: {
      recordingId: `${s.id}#answer-${s.answers.length + 1}`,
      startSec: utterance.startSec,
      endSec: utterance.endSec,
      speaker,
      quote: utterance.text,
    },
    source: "answer",
  };
}

/** 父の答えの 1 発話を作業に当てる。入力は書き換えない。asking でなければ throw。 */
export function answerSession(s: Session, utterance: Segment, ledger: LedgerEntry[], now: Date): Session {
  if (s.status !== "asking") throw new Error(`asking でないので答えを受けられない: ${s.status}`);
  if (s.invoice === null || s.transcript === null || s.refs === null) throw new Error("明細が無いので答えを受けられない");
  const at = now.toISOString();
  const base = answerBase(s, utterance, now);
  const speaker = base.provenance.speaker;
  const keep = (questionIndex: number, lineIndex: number, action: Action): Session => ({
    ...s,
    answers: [...s.answers, { ...base, questionIndex, lineIndex, action }],
    updatedAt: at,
  });

  if (isApproval(utterance.text)) {
    // 客の声では承認しない（話者が分からない声は通す。最後は父が画面で見る）
    if (speaker === "customer") return keep(-1, -1, unread("客の声"));
    if (pendingCount(s) === 0) {
      const answers: Answer[] = [...s.answers, { ...base, questionIndex: -1, lineIndex: -1, action: { kind: "approve" } }];
      return transition({ ...s, answers, approved: true, approvedAt: at }, "done", now);
    }
    return keep(-1, -1, unread("確認事項が残っている"));
  }

  const x = { candidates: s.candidates, refs: s.refs };
  const q = s.questions[0];
  if (q === undefined) return keep(-1, -1, unread("聞いている質問が無い"));
  // 客の答えは作業の側で一覧と照らす（run.ts の replySession）。ここに来るのは照合が決まらなかった答え
  if (q.reason === "customer") return keep(0, -1, unread("お客様が分からない"));
  const kept = keptLines(s.refs.lines.length, s.answers);
  const line = q.lineIndex >= 0 ? s.invoice.lines[q.lineIndex] : undefined;
  let action = readAnswer(q, line, utterance, ledger, s.candidates);
  // 客の声の はい・いいえ で、否定の行を取り消しも残しもしない
  if ((action.kind === "drop" || action.kind === "deny") && speaker === "customer") action = unread("客の声");
  const lineIndex = q.lineIndex >= 0 ? (kept[q.lineIndex] ?? -1) : -1;
  if (action.kind === "unread") return keep(0, lineIndex, action);

  const answers: Answer[] = [...s.answers, { ...base, questionIndex: 0, lineIndex, action }];
  const drafting = transition({ ...s, answers }, "drafting", now);
  const r = applyAnswers(x, s.transcript, ledger, answers);
  const invoice: AssembledInvoice = { lines: r.lines, confirmations: r.confirmations, total: r.total, unused: r.unused };
  const questions = withCustomerQuestion(toQuestions(invoice, s.candidates, s.transcript, ledger), s);
  return transition({ ...drafting, invoice, questions }, "asking", now);
}
