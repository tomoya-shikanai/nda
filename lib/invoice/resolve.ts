/**
 * モデルの参照（候補 ID）を発話の値に戻し、確認事項を出す（設計 docs/design/invoice-verify.md の (c)）。
 * 純粋な関数。API を呼ばない、入力を書き換えない。数は候補からだけ取り、推測で埋めない。
 * 金額（amount）は使用済みに数えるだけで、検算は V4 で行う。
 */
import { type LedgerEntry, findEntry } from "../ledger/lookup";
import type { Transcript } from "../stt/types";
import { type Candidate, type CandidateKind, normalizeText } from "./candidates";
import type { Confirmation } from "./price";
import type { InvoiceLine, LineRef } from "./schema";

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
    if (typeof ref.item === "string") {
      const c = pick(ref.item, "item");
      if (c) {
        item = c.ledgerItem ?? c.text;
        itemSpan = c;
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

  confirmations.sort((a, b) => a.lineIndex - b.lineIndex);
  return { lines, confirmations, unused };
}
