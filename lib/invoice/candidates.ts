/**
 * 発話から「言われた数」と「料金表の語」を候補として列挙する（設計 docs/design/invoice-verify.md の (a)）。
 * 純粋な関数。API を呼ばない、入力を書き換えない、同じ入力なら同じ出力。
 * 数は「最大の数字の並び」（算用数字・漢数字・十百千万・間の「,」「.」）を 1 つの塊として読み、
 * 塊全体が 1 つの数として読めたときだけ数にする。塊の途中や末尾だけを拾わない。
 * 読めない塊は捨てずに候補にする（円が続けば unparsedYen、そうでなければ unparsedNumber）。数を推測で作らない。
 * 旧 `verify.ts`（V4 で削除）から必要なものは写した。
 */
import { type LedgerEntry, findEntry } from "../ledger/lookup";
import type { Transcript } from "../stt/types";

export type CandidateKind =
  | "qty"
  | "unitPrice"
  | "total"
  | "amount"
  | "unparsedYen"
  | "unparsedNumber"
  | "bareNumber"
  | "item";

export type Candidate = {
  id: string;
  kind: CandidateKind;
  /** 発話の添字（t.segments の何番目か）。 */
  seg: number;
  /** 正規化後の発話の文字位置。start を含み end を含まない。 */
  start: number;
  end: number;
  /** その範囲の正規化後の文字列。 */
  text: string;
  /** item・unparsedYen・unparsedNumber は null。 */
  value: number | null;
  unit: string | null;
  /** total だけ。 */
  taxIncluded?: boolean;
  /** amount で、直前が「数＋単位＋で」のときのその数。 */
  impliedQty?: number;
  /** item で、findEntry で 1 つに決まるときの正式名。 */
  ledgerItem?: string;
};

/** 数量に付く単位。長いものを先に置く。 */
const UNITS = ["セット", "箇所", "か所", "ヶ所", "本", "個", "台", "輪", "つ", "枚", "式", "回"];
const UNIT = `(?:${UNITS.join("|")})`;

const KANJI_DIGIT: Record<string, number> = {
  〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const KANJI_MULT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const KANJI_CHARS = "〇一二三四五六七八九十百千万";
const NUM_CHAR = `[0-9${KANJI_CHARS}]`;
/** 最大の数字の並び。「,」「.」は数字に挟まれたときだけ並びに含める。 */
const NUM_RUN = new RegExp(`${NUM_CHAR}+(?:[.,]${NUM_CHAR}+)*`, "g");

function digitOf(c: string): number | undefined {
  if (c >= "0" && c <= "9") return Number(c);
  return KANJI_DIGIT[c];
}

/**
 * 万より下の 1 区切り（「三百三十」「2千500」「千百」「2000」）。位取りとして崩れていれば null。
 * 位の前は 1〜9 の 1 字、位の後ろの端数は漢数字 1 字か、直前の位より小さい算用数字の並び。
 */
function parseSection(s: string): number | null {
  if (s === "") return null;
  const parts = s.split(/([十百千])/);
  // parts は [係数, 位, 係数, 位, …, 端数]
  let total = 0;
  let lastMult = Infinity;
  for (let i = 1; i < parts.length; i += 2) {
    const m = KANJI_MULT[parts[i]];
    if (m >= lastMult) return null;
    const coef = parts[i - 1];
    let k = 1;
    if (coef !== "") {
      const d = coef.length === 1 ? digitOf(coef) : undefined;
      // 数字が 2 字続く（「二二十」）・位の前の〇は崩れとみなす
      if (d === undefined || d === 0) return null;
      k = d;
    }
    total += k * m;
    lastMult = m;
  }
  const tail = parts[parts.length - 1];
  if (tail === "") return total;
  if (/^[0-9]+$/.test(tail)) {
    const v = Number(tail);
    return v < lastMult ? total + v : null;
  }
  const d = tail.length === 1 ? digitOf(tail) : undefined;
  if (d === undefined || d === 0) return null;
  return total + d;
}

/**
 * 1 つの数字の並びを数にする。読めなければ null。
 * - 算用数字だけ: 「12000」「12,000」「33.0」（「,」は 3 桁ごとのときだけ）
 * - 位の字（十百千万）が無い漢数字まじり: 1 字ずつの読み（「三三〇」→ 330）
 * - 位の字がある: 位取り（「三百三十」→ 330、「1万2000」→ 12000、「2千500」→ 2500）
 */
function parseRun(run: string): number | null {
  if (/^[0-9.,]+$/.test(run)) {
    return /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(run) ? Number(run.replace(/,/g, "")) : null;
  }
  if (/[.,]/.test(run)) return null;
  if (!/[十百千万]/.test(run)) {
    let out = "";
    for (const c of run) out += String(digitOf(c));
    return Number(out);
  }
  const parts = run.split("万");
  if (parts.length > 2) return null;
  if (parts.length === 2) {
    // 「万」だけなら 1 万（「千」だけが 1000 なのと同じ）
    const hi = parts[0] === "" ? 1 : parseSection(parts[0]);
    if (hi === null || hi === 0) return null;
    const lo = parts[1] === "" ? 0 : parseSection(parts[1]);
    if (lo === null || lo >= 10000) return null;
    return hi * 10000 + lo;
  }
  return parseSection(run);
}

/**
 * 候補の文法の正規化。NFKC、漢数字を含む数字の並び→算用数字、空白の除去の 3 つだけ。
 * 小数点・句読点・カンマは消さない。読めない並び（「二二十」「3,1320」）はそのまま残す。
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(NUM_RUN, (run) => {
      if (!new RegExp(`[${KANJI_CHARS}]`).test(run)) return run;
      const v = parseRun(run);
      return v === null ? run : String(v);
    });
}

/** 正規化後の文字列の中の数字の並び。value は読めなければ null。 */
type NumRun = { start: number; end: number; value: number | null };

function numberRuns(n: string): NumRun[] {
  return [...n.matchAll(NUM_RUN)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    value: parseRun(m[0]),
  }));
}

/** 位置 i から始まる単位（長いものを先に）。無ければ null。 */
function unitAt(n: string, i: number): string | null {
  return UNITS.find((u) => n.startsWith(u, i)) ?? null;
}

const RANGE_MARKS = new Set(["-", "~", "〜"]);
const UNIT_PRICE_LINK = new RegExp(`^(${UNIT})(?:あたり|当たり|につき)?(?:は|が)?[、,]?$`);
const UNIT_PRICE_WORD = /単価(?:は|が)?$/;
const TOTAL_TAX = /(?:税込み|税込)(?:で|は|、)*$/;
const TOTAL_PLAIN = /(?:合計|全部で|総額|締めて)(?:で|は|、)*$/;
const YEN_TRAIL = new RegExp(`[0-9${KANJI_CHARS}.,]`);

type Raw = Omit<Candidate, "id">;

function numberCandidates(n: string, seg: number): Raw[] {
  const out: Raw[] = [];
  const runs = numberRuns(n);
  /** 読めた数だけ。 */
  const tokens = runs.filter((r): r is NumRun & { value: number } => r.value !== null);
  const byEnd = new Map(runs.map((r) => [r.end, r]));
  /** 円・数量・単価の「1」として使った並びの start。残りは bareNumber にする。 */
  const consumed = new Set<number>();
  const mk = (kind: Raw["kind"], start: number, end: number, value: number | null, unit: string | null): Raw => ({
    kind, seg, start, end, text: n.slice(start, end), value, unit,
  });

  for (let i = n.indexOf("円"); i >= 0; i = n.indexOf("円", i + 1)) {
    const end = i + 1;
    const run = byEnd.get(i);
    if (!run || run.value === null) {
      // 読めない並び（「二二十円」）か、円の直前が数字でない（「33.円」）
      let s = i;
      while (s > 0 && YEN_TRAIL.test(n[s - 1])) s--;
      for (const r of runs) if (r.start >= s && r.end <= i) consumed.add(r.start);
      out.push(mk("unparsedYen", s, end, null, null));
      continue;
    }
    const num = { ...run, value: run.value };
    consumed.add(num.start);
    const prefix = n.slice(0, num.start);

    // 「1＋単位＋（あたり）（は・が）（、）＋数＋円」
    const one = tokens.find((t) => t.end <= num.start && n.slice(t.start, t.end) === "1" && UNIT_PRICE_LINK.test(n.slice(t.end, num.start)));
    if (one) {
      consumed.add(one.start);
      out.push(mk("unitPrice", one.start, end, num.value, unitAt(n, one.end)));
      continue;
    }
    const word = UNIT_PRICE_WORD.exec(prefix);
    if (word) {
      out.push(mk("unitPrice", word.index, end, num.value, null));
      continue;
    }
    const tax = TOTAL_TAX.exec(prefix);
    if (tax) {
      out.push({ ...mk("total", tax.index, end, num.value, null), taxIncluded: true });
      continue;
    }
    const plain = TOTAL_PLAIN.exec(prefix);
    if (plain) {
      out.push({ ...mk("total", plain.index, end, num.value, null), taxIncluded: false });
      continue;
    }
    // 「数＋単位＋で＋数＋円」なら、その数を impliedQty に
    const q = tokens.find((t) => {
      if (t.end > num.start) return false;
      const u = unitAt(n, t.end);
      return u !== null && t.end + u.length + 1 === num.start && n[num.start - 1] === "で";
    });
    if (q) {
      out.push({ ...mk("amount", num.start, end, num.value, unitAt(n, q.end)), impliedQty: q.value });
    } else {
      out.push(mk("amount", num.start, end, num.value, null));
    }
  }

  for (const r of runs) {
    if (consumed.has(r.start)) continue;
    const u = unitAt(n, r.end);
    const after = u === null ? r.end : r.end + u.length;
    if (r.value === null) {
      // 読めない並び。単位が続いても数量にしない
      out.push(mk("unparsedNumber", r.start, after, null, u));
      continue;
    }
    const ranged = RANGE_MARKS.has(n[r.start - 1]) || RANGE_MARKS.has(n[after]);
    if (u !== null && !ranged) out.push(mk("qty", r.start, after, r.value, u));
    else out.push(mk("bareNumber", r.start, after, r.value, u));
  }
  return out;
}

function itemCandidates(n: string, seg: number, ledger: LedgerEntry[], normLedger: LedgerEntry[]): Raw[] {
  const names = [...new Set(normLedger.flatMap((e) => [e.item, ...e.aliases]).filter((k) => k.length > 0))];
  const hits: { start: number; end: number }[] = [];
  for (const k of names) {
    for (let i = n.indexOf(k); i >= 0; i = n.indexOf(k, i + 1)) hits.push({ start: i, end: i + k.length });
  }
  // 長い語を先に、同じ長さなら前から。重なるものは取らない
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: { start: number; end: number }[] = [];
  for (const h of hits) {
    if (taken.some((x) => h.start < x.end && x.start < h.end)) continue;
    taken.push(h);
  }
  return taken.map((h) => {
    const text = n.slice(h.start, h.end);
    const raw: Raw = { kind: "item", seg, start: h.start, end: h.end, text, value: null, unit: null };
    const hit = findEntry(normLedger, text);
    if (hit) raw.ledgerItem = ledger[normLedger.indexOf(hit)].item;
    return raw;
  });
}

const PREFIX: Record<CandidateKind, string> = {
  qty: "q", unitPrice: "p", total: "t", amount: "a", unparsedYen: "u", unparsedNumber: "x", bareNumber: "n", item: "i",
};
const KIND_ORDER: CandidateKind[] = ["qty", "unitPrice", "total", "amount", "unparsedYen", "unparsedNumber", "bareNumber", "item"];

/** 文字起こしの各発話から候補を列挙する。ID は kind ごとの頭文字＋1 からの連番で、(seg, start) の順。 */
export function enumerateCandidates(t: Transcript, ledger: LedgerEntry[]): Candidate[] {
  const normLedger = ledger.map((e) => ({ ...e, item: normalizeText(e.item), aliases: e.aliases.map(normalizeText) }));
  const raws = t.segments.flatMap((s, seg) => {
    const n = normalizeText(s.text);
    return [...numberCandidates(n, seg), ...itemCandidates(n, seg, ledger, normLedger)];
  });
  raws.sort(
    (a, b) =>
      a.seg - b.seg ||
      a.start - b.start ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.end - b.end,
  );
  const counters = new Map<CandidateKind, number>();
  return raws.map((r) => {
    const k = (counters.get(r.kind) ?? 0) + 1;
    counters.set(r.kind, k);
    return { id: `${PREFIX[r.kind]}${k}`, ...r };
  });
}
