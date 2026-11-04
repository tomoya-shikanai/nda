/**
 * モデルの参照（候補 ID）を発話の値に戻し、確認事項を出す（設計 docs/design/invoice-verify.md の (c)）。
 * 純粋な関数。API を呼ばない、入力を書き換えない。数は候補からだけ取り、推測で埋めない。
 * 金額（amount）は使用済みに数えるだけで、検算は check.ts の checkAmounts で行う。
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

/** 言い直しの訂正前・訂正後に指せる候補の種類（数だけ）。extract.ts の refSchema と同じ。 */
export const CORRECTION_KINDS = new Set<CandidateKind>(["qty", "bareNumber", "unitPrice", "amount"]);

/** 1 つずつ数える単位。この単位の数量が整数でなければ確認事項にする（「0.4本」）。セット・式などは見ない。 */
export const COUNT_UNITS = new Set(["本", "個", "台", "輪", "枚", "つ", "箇所", "か所", "ヶ所", "回"]);

/**
 * 条件 6 の例外（1 つの数量を複数の行が使う）で、文に残ってよい語。数量・使う行の品目の語を除いた残りが、
 * つなぎとこの語だけでできているときだけ共有を許す（「組替4本、バランスは前だけ。」の「前だけ」が残れば許さない）。
 * 語彙を足して閉じるのでなく、ここに無い語が 1 つでも残れば確認事項にする。語彙はここだけに置く。
 */
export const SHARED_QTY_LINKS = ["、", ",", "と", "や", "も", "は", "を", "の"];
export const SHARED_QTY_WORDS = ["タイヤ", "だ", "です", "じゃ", "な", "ね", "よ", "した", "やった", "替えた", "交換"];
const SHARED_QTY_TOKENS = [...SHARED_QTY_LINKS, ...SHARED_QTY_WORDS].sort((a, b) => b.length - a.length);

/** 文字列が、許した語（長いものから前へ順に取る）だけでできているか。 */
function onlySharedTokens(rest: string): boolean {
  let i = 0;
  while (i < rest.length) {
    const t = SHARED_QTY_TOKENS.find((w) => rest.startsWith(w, i));
    if (t === undefined) return false;
    i += t.length;
  }
  return true;
}

/** 文の区切り。発話の終わりも文の終わり。「、」では切らない。 */
const SENTENCE_BREAK = /[。！？!?]/;

/** 使われない数のうち、行から 20 秒以内なら確認事項にするもの。unitPrice・amount は距離によらず確認事項。 */
const NEAR_KINDS = new Set<CandidateKind>(["qty", "bareNumber"]);
const SPEAKERS = new Set(["father", "customer", "son"]);

type Span = { seg: number; start: number; end: number };

/** 確認事項に、関係する候補の ID を付ける（聞き返しの文に値を入れるため）。無ければ付けない。 */
function withCandidates(c: Confirmation, related: (Candidate | null)[]): Confirmation {
  const ids = [...new Set(related.filter((x): x is Candidate => x !== null).map((x) => x.id))];
  return ids.length ? { ...c, candidates: ids } : c;
}

export type ResolvedInvoice = {
  lines: InvoiceLine[];
  confirmations: Confirmation[];
  /** どの行からも参照されなかった qty・unitPrice・amount・bareNumber の候補。画面で灰色に出す（確認事項にもなるものを含む）。 */
  unused: Candidate[];
};

/**
 * 正規化後の発話 n の [start, end) を含む文の範囲（「。」「！」「？」「!」「?」と発話の端で区切る）。
 * 範囲の末尾が区切りの字なら、そこで文を閉じる（次の文へ広げない）。
 */
function sentenceAt(n: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  while (s > 0 && !SENTENCE_BREAK.test(n[s - 1])) s--;
  let e = end;
  if (e > start && SENTENCE_BREAK.test(n[e - 1])) e--;
  while (e < n.length && !SENTENCE_BREAK.test(n[e])) e++;
  return { start: s, end: e };
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
    const r = sentenceAt(n, sp.start, sp.end);
    const sentence = n.slice(r.start, r.end);
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
  /** 行ごとの、品目の語の位置（item 候補か `{seg,text}`。無ければ null）。条件 6 の共有の数量で見る。 */
  const lineItemSpans: (Span | null)[] = [];
  /** qty 候補 ID → それを使った行（順に）。 */
  const qtyUsers = new Map<string, number[]>();
  const within = (sp: Span, r: Span) => sp.seg === r.seg && sp.start >= r.start && sp.end <= r.end;
  /**
   * 条件 6 の例外: 1 つの数量の候補を複数の行が使ってよいのは、その数量と、使う行すべての品目の語が同じ文にあり、
   * その文にほかの数量の候補（qty・bareNumber）が無いときだけ（「タイヤ4本、組替とバランスだ。」）。
   * 品目の語は行ごとに別の箇所であること（同じ語を候補と `{seg,text}` で 2 回指したものは許さない）。
   * 形が合わなければ（別の文・語の重なり・ほかの数量）後の行を「同じ根拠」にする。
   */
  const qtyShareShape = (qty: Candidate, users: number[]): boolean => {
    const n = normSegs[qty.seg];
    if (n === undefined) return false;
    const r: Span = { seg: qty.seg, ...sentenceAt(n, qty.start, qty.end) };
    const spans = users.map((li) => lineItemSpans[li]);
    if (!spans.every((sp): sp is Span => sp != null && within(sp, r))) return false;
    const overlap = (a: Span, b: Span) => a.seg === b.seg && a.start < b.end && b.start < a.end;
    if (spans.some((a, i) => spans.some((b, j) => i < j && overlap(a, b)))) return false;
    return !candidates.some((c) => (c.kind === "qty" || c.kind === "bareNumber") && c.id !== qty.id && within(c, r));
  };
  /**
   * 形が合ったうえで、その文から数量の候補と使う行の品目の語を除いた残りが、つなぎと決まった語だけか
   * （SHARED_QTY_LINKS・SHARED_QTY_WORDS）。何か残れば、数量がどの行にどこまで掛かるか分からない。
   */
  const qtyShareOk = (qty: Candidate, users: number[]): boolean => {
    if (!qtyShareShape(qty, users)) return false;
    const n = normSegs[qty.seg];
    const r = sentenceAt(n, qty.start, qty.end);
    const cut = [qty, ...users.map((li) => lineItemSpans[li] as Span)];
    // 除いた箇所で切った残りの断片を、それぞれ許した語だけで読めるか
    let piece = "";
    for (let i = r.start; i <= r.end; i++) {
      const removed = i < r.end && cut.some((sp) => i >= sp.start && i < sp.end);
      if (i < r.end && !removed) {
        piece += n[i];
        continue;
      }
      if (!onlySharedTokens(piece)) return false;
      piece = "";
    }
    return true;
  };
  /** 行ごとの、品目の正式名（料金表で 1 つに決まる語はその正式名、無ければ語そのもの）と、指した品目の語（正規化後）。 */
  const lineKeys: string[] = [];
  const lineNeedles: string[] = [];
  /** status が negated の行の、evidence と参照の候補の発話（negated でない行は空）。条件 18 の (3) で見る。 */
  const negatedSegs: number[][] = [];
  /**
   * 品目の正式名が key の語（同じ正式名の item 候補と、料金表に無い品目の語 needle）が、
   * 範囲 r（無ければ、否定の合図のある文）に入るか。同じ品目の 2 回目の語の否定（「脱着4本。脱着はいらない。」）を拾う。
   */
  const sameItemIn = (key: string, needle: string, r: Span | null): boolean => {
    const ok = (sp: Span) => (r === null ? negated(sp) : sp.seg === r.seg && sp.start >= r.start && sp.end <= r.end);
    if (candidates.some((c) => c.kind === "item" && (c.ledgerItem ?? c.text) === key && ok(c))) return true;
    if (needle === "") return false;
    return normSegs.some((n, seg) => {
      for (let at = n.indexOf(needle); at >= 0; at = n.indexOf(needle, at + 1)) {
        if (ok({ seg, start: at, end: at + needle.length })) return true;
      }
      return false;
    });
  };

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
    /** 判定の根拠の ID。値には使わないので、候補にあるか（言い直しは数の種類か）だけを見る。 */
    const known = (id: string | null, kinds?: Set<CandidateKind>): Candidate | null => {
      if (id === null) return null;
      const c = byId.get(id);
      if (!c || (kinds && !kinds.has(c.kind))) {
        invalid = true;
        return null;
      }
      return c;
    };
    const evidence = ref.evidence.map((e) => known(e));
    const correctedFrom = known(ref.correctedFrom, CORRECTION_KINDS);
    const correctedTo = known(ref.correctedTo, CORRECTION_KINDS);
    lineCands.push(
      [itemCand, qty, unitPrice, amount, correctedFrom, correctedTo].filter((c): c is Candidate => c !== null),
    );
    lineWords.push(typeof ref.item === "string" ? null : itemSpan);
    lineItemSpans.push(itemSpan);
    const key = itemCand ? (itemCand.ledgerItem ?? itemCand.text) : (findEntry(ledger, item)?.item ?? item);
    const needle = itemCand ? "" : normalizeText(item);
    lineKeys.push(key);
    negatedSegs.push(
      ref.status === "negated"
        ? [...new Set([...segs, ...evidence.filter((c): c is Candidate => c !== null).map((c) => c.seg)])]
        : [],
    );
    lineNeedles.push(needle);

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

    const add = (field: Confirmation["field"], message: string, related: (Candidate | null)[] = []) =>
      confirmations.push(withCandidates({ lineIndex, item, field, message }, related));
    if (invalid) add("line", `「${item}」の行に候補に無い・種類の違う参照がある（参照が不正）`);
    if (qty === null) add("qty", `「${item}」の数量が分からない`);
    if (qty !== null && qty.value !== null && qty.unit !== null && COUNT_UNITS.has(qty.unit) && !Number.isInteger(qty.value)) {
      add("qty", `「${item}」の数量 ${qty.text} が整数でない（数量が整数でない）`);
    }
    if (itemWordMissing) add("item", `「${item}」は指した発話に無い（品目の語が発話に無い）`);
    // 行が使った候補の文か、同じ品目の語のある文に否定の合図がある
    if ([itemSpan, qty, unitPrice, amount].some((sp) => sp !== null && negated(sp)) || sameItemIn(key, needle, null)) {
      add("line", `「${item}」の行の文に否定の合図がある（否定）`, [qty]);
    }
    if (qty?.unit && unitPrice?.unit && qty.unit !== unitPrice.unit) {
      add("unit", `「${item}」の単位が数量（${qty.unit}）と単価（${unitPrice.unit}）で違う（単位が数量と単価で違う）`);
    }
    if (used.length && endSec - startSec > MAX_LINE_SEC) {
      add("line", `「${item}」の根拠が ${MAX_LINE_SEC} 秒に収まらない（20 秒）`);
    }
    const sharedIds = ids.filter((id) => usedBy.has(id));
    const sharedWord = itemWordKey !== null && itemWordBy.has(itemWordKey);
    const qtyOnly = qty !== null && sharedIds.length > 0 && sharedIds.every((id) => id === qty.id);
    const shared =
      sharedWord ||
      (sharedIds.length > 0 && !(qtyOnly && qtyShareShape(qty, [...(qtyUsers.get(qty.id) ?? []), lineIndex])));
    if (shared) add("line", `「${item}」の行が前の行と同じ発話の箇所を指している（同じ根拠）`);
    // 条件 17: モデルが done 以外と判定した行
    if (ref.status === "negated") add("line", `「${item}」の行をモデルが否定・取り消し・断りと判定した（否定）`, [qty]);
    // 言い直しの訂正前・訂正後を書いたら、status によらず確かめる（モデルが言い直しに気づいたのに done にした場合）
    if (ref.status === "corrected" || ref.correctedFrom !== null || ref.correctedTo !== null) {
      const from = correctedFrom?.text ?? "不明";
      const to = correctedTo?.text ?? "不明";
      const judged = ref.status === "corrected" ? "行をモデルが言い直しと判定した" : "行にモデルが言い直しの訂正前・訂正後を書いた";
      add("line", `「${item}」の${judged}（言い直し: ${from} → ${to}）`, [correctedFrom, correctedTo]);
    }
    // unsure と、型の外の値（status が無い等）は安全側に倒して確かめる
    if (ref.status !== "done" && ref.status !== "negated" && ref.status !== "corrected") add("line", `「${item}」の行をモデルが確かでないと判定した（確かでない）`);
    for (const id of ids) if (!usedBy.has(id)) usedBy.set(id, lineIndex);
    if (qty !== null) qtyUsers.set(qty.id, [...(qtyUsers.get(qty.id) ?? []), lineIndex]);
    if (itemWordKey !== null && !itemWordBy.has(itemWordKey)) itemWordBy.set(itemWordKey, lineIndex);
  });

  // 条件 6 の例外の続き: 1 つの数量を複数の行が使い、文に許した語のほかが残れば、使った行すべてを確認事項（数量）にする
  for (const [id, users] of qtyUsers) {
    const qty = byId.get(id) as Candidate;
    if (users.length < 2 || qtyShareOk(qty, users)) continue;
    for (const li of users) {
      confirmations.push({
        lineIndex: li,
        item: lines[li].item,
        field: "qty",
        message: `「${lines[li].item}」の数量 ${qty.text} をほかの行と分けて使っていて、どの行にどこまで掛かるか分からない（同じ根拠）`,
        candidates: [qty.id],
      });
    }
  }

  const unused = candidates
    .filter((c) => (NEAR_KINDS.has(c.kind) || c.kind === "unitPrice" || c.kind === "amount") && !usedBy.has(c.id))
    .map((c) => ({ ...c }));
  const global = (item: string, field: Confirmation["field"], message: string, related: Candidate[] = []) =>
    confirmations.push(withCandidates({ lineIndex: -1, item, field, message }, related));

  for (const c of unused) {
    if (c.kind === "unitPrice" || c.kind === "amount") {
      global(c.text, "unitPrice", `「${c.text}」（言った金額がどの行にも使われていない）`, [c]);
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
          candidates: [c.id],
        });
      }
    }
  }
  for (const c of candidates) {
    if (c.kind === "unparsedYen") global(c.text, "unitPrice", `「${c.text}」（円の前の数が読めない）`, [c]);
    if (c.kind === "unparsedNumber") global(c.text, "qty", `「${c.text}」（数が読めない）`, [c]);
  }

  const lineAdd = (lineIndex: number, field: Confirmation["field"], message: string, related: Candidate[] = []) =>
    confirmations.push(withCandidates({ lineIndex, item: lines[lineIndex].item, field, message }, related));

  // モデルが挙げた否定・取り消し・断りの文の範囲。指した発話の中の一致を全部探し、それぞれを文全体に広げる
  // （モデルが文の一部だけ写した「替えてない」も、同じ文が 2 回ある 2 回目も拾う）
  const negRanges: { neg: NegatedSentence; range: Span }[] = [];
  for (const neg of negations) {
    const needle = normalizeText(neg.text);
    const inRange = Number.isInteger(neg.seg) && neg.seg >= 0 && neg.seg < normSegs.length;
    const n = inRange ? normSegs[neg.seg] : "";
    let found = false;
    for (let at = needle === "" ? -1 : n.indexOf(needle); at >= 0; at = n.indexOf(needle, at + 1)) {
      found = true;
      negRanges.push({ neg, range: { seg: neg.seg, ...sentenceAt(n, at, at + needle.length) } });
    }
    if (!found) global(neg.text, "line", `「${neg.text}」（否定の文が発話に無い）`);
  }

  // 条件 15: 料金表の語が出たのに、その正式名の行が無い（否定の合図の文の語と、モデルが挙げた否定の文の語は除く）
  const lineNames = new Set(lines.map((l) => findEntry(ledger, l.item)?.item ?? l.item));
  const reported = new Set<string>();
  for (const c of candidates) {
    if (c.kind !== "item" || c.ledgerItem === undefined || negated(c)) continue;
    if (negRanges.some(({ range }) => within(c, range))) continue;
    if (lineNames.has(c.ledgerItem) || reported.has(c.ledgerItem)) continue;
    reported.add(c.ledgerItem);
    global(c.ledgerItem, "item", `「${c.text}」（${c.ledgerItem}）と言った（料金表の品目の語が出たのに行が無い）`, [c]);
  }

  // 条件 18: モデルが挙げた否定・取り消し・断りの文は、例外なく必ずどこかの確認事項にする（1 つの文につき行ごとに 1 件）
  // - 行が使った候補・品目の語か、同じ品目（正式名）の語が文に入る行 → その行
  // - そのような行が無ければ、文の発話から 20 秒以内に evidence か参照の候補がある negated の行のうち最も近い行
  // - それも無ければ行に付かない確認事項（文の品目の語を付ける。「バランスは大丈夫です。」で行が無い場合も聞く）
  for (const neg of negations) {
    const ranges = negRanges.filter((x) => x.neg === neg).map((x) => x.range);
    if (ranges.length === 0) continue; // 発話に無い文は上で確認事項にした
    let any = false;
    for (let li = 0; li < lines.length; li++) {
      const word = lineWords[li];
      const hit = ranges.some(
        (range) =>
          lineCands[li].some((c) => NEGATION_SPAN_KINDS.has(c.kind) && within(c, range)) ||
          (word !== null && within(word, range)) ||
          sameItemIn(lineKeys[li], lineNeedles[li], range),
      );
      if (hit) {
        any = true;
        const qty = lineCands[li].filter((c) => c.kind === "qty");
        lineAdd(li, "line", `「${lines[li].item}」の行がモデルの挙げた否定の文「${neg.text}」に入る（否定）`, qty);
      }
    }
    if (!any) {
      let near = -1;
      let bestGap = Infinity;
      for (let li = 0; li < lines.length; li++) {
        for (const sg of negatedSegs[li]) {
          const gap = gapSec(neg.seg, sg);
          if (gap <= MAX_LINE_SEC && gap < bestGap) [near, bestGap] = [li, gap];
        }
      }
      if (near >= 0) {
        const qty = lineCands[near].filter((c) => c.kind === "qty");
        lineAdd(near, "line", `「${lines[near].item}」の行の近くにモデルの挙げた否定の文「${neg.text}」がある（否定）`, qty);
      } else {
        const words = candidates.filter((c) => c.kind === "item" && ranges.some((range) => within(c, range)));
        const why = words.length ? "モデルの挙げた否定の文の品目の行が無い" : "モデルの挙げた否定の文に品目が無く、どの行のことか分からない";
        global(neg.text, "line", `「${neg.text}」（${why}）（否定）`, words);
      }
    }
  }

  // 条件 19: 訂正の合図がある発話の数を使った行と、その近くの同じ単位の数量を使った別の行（発話をまたぐ訂正）
  const correctionSegs = new Set(
    normSegs.flatMap((n, i) => (CORRECTION_CUES.some((w) => n.includes(w)) ? [i] : [])),
  );
  for (let li = 0; li < lines.length; li++) {
    const cued = lineCands[li].filter((c) => (c.kind === "qty" || c.kind === "bareNumber") && correctionSegs.has(c.seg));
    let clash: [Candidate, Candidate] | null = null;
    for (const c of cued) {
      const partner = lineCands
        .flatMap((other, oi) => (oi === li ? [] : other))
        .find((o) => o.kind === "qty" && o.unit === c.unit && gapSec(c.seg, o.seg) <= MAX_LINE_SEC);
      if (partner) {
        clash = [c, partner];
        break;
      }
    }
    if (clash) {
      lineAdd(
        li,
        "qty",
        `「${lines[li].item}」の行の ${clash[0].text} は訂正の合図がある発話の数で、近くの別の行も同じ単位の数量を使っている（言い直し）`,
        clash,
      );
    }
  }

  confirmations.sort((a, b) => a.lineIndex - b.lineIndex);
  return { lines, confirmations, unused };
}
