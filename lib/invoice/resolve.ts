/**
 * モデルの参照（候補 ID）を発話の値に戻し、確認事項を出す（設計 docs/design/invoice-verify.md の (c)）。
 * 純粋な関数。API を呼ばない、入力を書き換えない。数は候補からだけ取り、推測で埋めない。
 * 金額（amount）は使用済みに数えるだけで、検算は V4 で行う。
 */
import { type LedgerEntry, findEntry } from "../ledger/lookup";
import type { Transcript } from "../stt/types";
import { type Candidate, type CandidateKind, normalizeText } from "./candidates";
import type { Confirmation } from "./price";
import type { InvoiceLine, LineRef, NegatedSentence } from "./schema";

/** 1 行の根拠の時間の幅の上限（秒）。 */
export const MAX_LINE_SEC = 20;

/**
 * 否定の合図。行が参照する候補のどれかの文にあれば確認事項にする。語彙はここだけに置く。
 * 方言（津軽弁）の「まいね」「わがね」「いらね」「やらね」「しね」を含む。
 */
export const NEGATION_CUES = [
  "しない", "いらない", "要らない", "なし", "無し", "まいね", "やらない",
  "不要", "いらね", "やらね", "しね", "やめ", "見送り", "わがね",
];

/** 訂正の合図（条件 19）。この合図がある発話の数を使った行を、言い直しの疑いとして確かめる。語彙はここだけに置く。 */
export const CORRECTION_CUES = ["いや", "やっぱり", "じゃなくて", "違う"];

/** 条件 18・19 で見る、行が使った候補の種類。 */
const NEGATION_SPAN_KINDS = new Set<CandidateKind>(["item", "qty", "unitPrice", "amount", "bareNumber"]);

/** 文の区切り。発話の終わりも文の終わり。「、」では切らない。 */
const SENTENCE_BREAK = /[。！？!?]/;

/** 使われない数のうち、行から 20 秒以内なら確認事項にするもの。unitPrice・amount は距離によらず確認事項。 */
const NEAR_KINDS = new Set<CandidateKind>(["qty", "bareNumber"]);
const SPEAKERS = new Set(["father", "customer", "son"]);

type Span = { seg: number; start: number; end: number };

export type ResolvedInvoice = {
  lines: InvoiceLine[];
  confirmations: Confirmation[];
  /** どの行からも参照されなかった qty・unitPrice・amount・bareNumber の候補。画面で灰色に出す（確認事項にもなるものを含む）。 */
  unused: Candidate[];
};

/** 正規化後の発話 n の [start, end) を含む文（「。」「！」「？」「!」「?」と発話の端で区切った範囲）。 */
function sentenceAt(n: string, start: number, end: number): string {
  let s = start;
  while (s > 0 && !SENTENCE_BREAK.test(n[s - 1])) s--;
  let e = end;
  while (e < n.length && !SENTENCE_BREAK.test(n[e])) e++;
  return n.slice(s, e);
}

export function resolveInvoice(
  refs: LineRef[],
  candidates: Candidate[],
  t: Transcript,
  ledger: LedgerEntry[],
  negations: NegatedSentence[] = [],
): ResolvedInvoice {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const normSegs = t.segments.map((s) => normalizeText(s.text));
  const negated = (sp: Span) => {
    const n = normSegs[sp.seg];
    if (n === undefined) return false;
    const sentence = sentenceAt(n, sp.start, sp.end);
    return NEGATION_CUES.some((w) => sentence.includes(w));
  };
  /** 発話 a と b の時刻の隔たり（秒）。重なれば 0。 */
  const gapSec = (a: number, b: number) => {
    const x = t.segments[a];
    const y = t.segments[b];
    return Math.max(0, Math.max(x.startSec, y.startSec) - Math.min(x.endSec, y.endSec));
  };

  const confirmations: Confirmation[] = [];
  /** 候補 ID → 最初に参照した行。 */
  const usedBy = new Map<string, number>();
  /** `{seg,text}` の品目 → 最初に使った行。 */
  const itemWordBy = new Map<string, number>();
  const lines: InvoiceLine[] = [];
  /** 行ごとの、参照した発話の添字。 */
  const lineSegs: number[][] = [];
  /** 行ごとの、使った候補（品目・数量・単価・金額と、言い直しの訂正前・訂正後）。条件 18・19 で見る。 */
  const lineCands: Candidate[][] = [];
  /** 行ごとの、`{seg,text}` の品目の語の位置。 */
  const lineWords: (Span | null)[] = [];

  refs.forEach((ref, lineIndex) => {
    const segs = new Set<number>();
    const ids: string[] = [];
    let invalid = false;
    const pick = (id: string | null, kind: CandidateKind): Candidate | null => {
      if (id === null) return null;
      const c = byId.get(id);
      if (!c || c.kind !== kind) {
        invalid = true;
        return null;
      }
      ids.push(c.id);
      segs.add(c.seg);
      return c;
    };

    let item = "";
    let itemSpan: Span | null = null;
    let itemWordKey: string | null = null;
    let itemWordMissing = false;
    let itemCand: Candidate | null = null;
    if (typeof ref.item === "string") {
      const c = pick(ref.item, "item");
      if (c) {
        item = c.ledgerItem ?? c.text;
        itemSpan = c;
        itemCand = c;
      }
    } else {
      const { seg, text } = ref.item;
      item = text;
      const needle = normalizeText(text);
      itemWordKey = `${seg}\u0000${needle}`;
      const inRange = Number.isInteger(seg) && seg >= 0 && seg < normSegs.length;
      const at = inRange && needle !== "" ? normSegs[seg].indexOf(needle) : -1;
      if (inRange) segs.add(seg);
      if (at < 0) itemWordMissing = true;
      else itemSpan = { seg, start: at, end: at + needle.length };
    }
    const qty = pick(ref.qty, "qty");
    const unitPrice = pick(ref.unitPrice, "unitPrice");
    const amount = pick(ref.amount, "amount");
    /** 判定の根拠の ID。値には使わないので、候補にあるかだけを見る。 */
    const known = (id: string | null): Candidate | null => {
      if (id === null) return null;
      const c = byId.get(id);
      if (!c) invalid = true;
      return c ?? null;
    };
    for (const e of ref.evidence) known(e);
    const correctedFrom = known(ref.correctedFrom);
    const correctedTo = known(ref.correctedTo);
    lineCands.push(
      [itemCand, qty, unitPrice, amount, correctedFrom, correctedTo].filter((c): c is Candidate => c !== null),
    );
    lineWords.push(typeof ref.item === "string" ? null : itemSpan);

    const order = [...segs].sort((a, b) => a - b);
    lineSegs.push(order);
    const used = order.map((i) => t.segments[i]);
    const startSec = used.length ? Math.min(...used.map((s) => s.startSec)) : 0;
    const endSec = used.length ? Math.max(...used.map((s) => s.endSec)) : 0;
    const speakers = new Set(used.map((s) => s.speaker));
    const only = speakers.size === 1 ? [...speakers][0] : null;
    const speaker = only !== null && SPEAKERS.has(only) ? (only as "father" | "customer" | "son") : "unknown";

    lines.push({
      item,
      qty: qty?.value ?? null,
      unit: qty ? qty.unit : (unitPrice?.unit ?? null),
      unitPrice: unitPrice?.value ?? null,
      provenance: {
        recordingId: t.recordingId,
        startSec,
        endSec,
        speaker,
        quote: used.map((s) => s.text).join(""),
      },
    });

    const add = (field: Confirmation["field"], message: string) =>
      confirmations.push({ lineIndex, item, field, message });
    if (invalid) add("line", `「${item}」の行に候補に無い・種類の違う参照がある（参照が不正）`);
    if (qty === null) add("qty", `「${item}」の数量が分からない`);
    if (itemWordMissing) add("item", `「${item}」は指した発話に無い（品目の語が発話に無い）`);
    if ([itemSpan, qty, unitPrice, amount].some((sp) => sp !== null && negated(sp))) {
      add("line", `「${item}」の行の文に否定の合図がある（否定）`);
    }
    if (qty?.unit && unitPrice?.unit && qty.unit !== unitPrice.unit) {
      add("unit", `「${item}」の単位が数量（${qty.unit}）と単価（${unitPrice.unit}）で違う（単位が数量と単価で違う）`);
    }
    if (used.length && endSec - startSec > MAX_LINE_SEC) {
      add("line", `「${item}」の根拠が ${MAX_LINE_SEC} 秒に収まらない（20 秒）`);
    }
    const shared =
      ids.some((id) => usedBy.has(id)) || (itemWordKey !== null && itemWordBy.has(itemWordKey));
    if (shared) add("line", `「${item}」の行が前の行と同じ発話の箇所を指している（同じ根拠）`);
    // 条件 17: モデルが done 以外と判定した行
    if (ref.status === "negated") add("line", `「${item}」の行をモデルが否定・取り消し・断りと判定した（否定）`);
    if (ref.status === "corrected") {
      const from = correctedFrom?.text ?? "不明";
      const to = correctedTo?.text ?? "不明";
      add("line", `「${item}」の行をモデルが言い直しと判定した（言い直し: ${from} → ${to}）`);
    }
    // unsure と、型の外の値（status が無い等）は安全側に倒して確かめる
    if (ref.status !== "done" && ref.status !== "negated" && ref.status !== "corrected") add("line", `「${item}」の行をモデルが確かでないと判定した（確かでない）`);
    for (const id of ids) if (!usedBy.has(id)) usedBy.set(id, lineIndex);
    if (itemWordKey !== null && !itemWordBy.has(itemWordKey)) itemWordBy.set(itemWordKey, lineIndex);
  });

  const unused = candidates
    .filter((c) => (NEAR_KINDS.has(c.kind) || c.kind === "unitPrice" || c.kind === "amount") && !usedBy.has(c.id))
    .map((c) => ({ ...c }));
  const global = (item: string, field: Confirmation["field"], message: string) =>
    confirmations.push({ lineIndex: -1, item, field, message });

  for (const c of unused) {
    if (c.kind === "unitPrice" || c.kind === "amount") {
      global(c.text, "unitPrice", `「${c.text}」（言った金額がどの行にも使われていない）`);
    } else {
      // 条件 3: いずれかの行が参照した発話から 20 秒以内（前後の発話をまたいでよい）。最も近い行に付ける
      let lineIndex = -1;
      let bestGap = Infinity;
      for (let li = 0; li < lineSegs.length; li++) {
        for (const s of lineSegs[li]) {
          const gap = gapSec(c.seg, s);
          if (gap <= MAX_LINE_SEC && gap < bestGap) [lineIndex, bestGap] = [li, gap];
        }
      }
      if (lineIndex >= 0) {
        const item = lines[lineIndex].item;
        confirmations.push({
          lineIndex,
          item,
          field: "qty",
          message: `「${item}」の行の近く（${MAX_LINE_SEC} 秒以内）に、どの行にも使われていない ${c.text} がある（言い直し・使われない数）`,
        });
      }
    }
  }
  for (const c of candidates) {
    if (c.kind === "unparsedYen") global(c.text, "unitPrice", `「${c.text}」（円の前の数が読めない）`);
    if (c.kind === "unparsedNumber") global(c.text, "qty", `「${c.text}」（数が読めない）`);
  }

  // 条件 15: 料金表の語が出たのに、その正式名の行が無い（否定の文の語は除く）
  const lineNames = new Set(lines.map((l) => findEntry(ledger, l.item)?.item ?? l.item));
  const reported = new Set<string>();
  for (const c of candidates) {
    if (c.kind !== "item" || c.ledgerItem === undefined || negated(c)) continue;
    if (lineNames.has(c.ledgerItem) || reported.has(c.ledgerItem)) continue;
    reported.add(c.ledgerItem);
    global(c.ledgerItem, "item", `「${c.text}」（${c.ledgerItem}）と言った（料金表の品目の語が出たのに行が無い）`);
  }

  const inside = (sp: Span, r: Span) => sp.seg === r.seg && sp.start >= r.start && sp.end <= r.end;
  const lineAdd = (lineIndex: number, field: Confirmation["field"], message: string) =>
    confirmations.push({ lineIndex, item: lines[lineIndex].item, field, message });

  // 条件 18: モデルが挙げた否定・取り消し・断りの文に、行が使った候補・品目の語が入る
  for (const neg of negations) {
    const needle = normalizeText(neg.text);
    const inRange = Number.isInteger(neg.seg) && neg.seg >= 0 && neg.seg < normSegs.length;
    const at = inRange && needle !== "" ? normSegs[neg.seg].indexOf(needle) : -1;
    if (at < 0) {
      global(neg.text, "line", `「${neg.text}」（否定の文が発話に無い）`);
      continue;
    }
    const range: Span = { seg: neg.seg, start: at, end: at + needle.length };
    for (let li = 0; li < lines.length; li++) {
      const word = lineWords[li];
      const hit =
        lineCands[li].some((c) => NEGATION_SPAN_KINDS.has(c.kind) && inside(c, range)) ||
        (word !== null && inside(word, range));
      if (hit) lineAdd(li, "line", `「${lines[li].item}」の行がモデルの挙げた否定の文「${neg.text}」に入る（否定）`);
    }
  }

  // 条件 19: 訂正の合図がある発話の数を使った行と、その近くの同じ単位の数量を使った別の行（発話をまたぐ訂正）
  const correctionSegs = new Set(
    normSegs.flatMap((n, i) => (CORRECTION_CUES.some((w) => n.includes(w)) ? [i] : [])),
  );
  for (let li = 0; li < lines.length; li++) {
    const cued = lineCands[li].filter((c) => (c.kind === "qty" || c.kind === "bareNumber") && correctionSegs.has(c.seg));
    const clash = cued.find((c) =>
      lineCands.some(
        (other, oi) =>
          oi !== li &&
          other.some((o) => o.kind === "qty" && o.unit === c.unit && gapSec(c.seg, o.seg) <= MAX_LINE_SEC),
      ),
    );
    if (clash) {
      lineAdd(
        li,
        "qty",
        `「${lines[li].item}」の行の ${clash.text} は訂正の合図がある発話の数で、近くの別の行も同じ単位の数量を使っている（言い直し）`,
      );
    }
  }

  confirmations.sort((a, b) => a.lineIndex - b.lineIndex);
  return { lines, confirmations, unused };
}
