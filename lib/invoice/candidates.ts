/**
 * 発話から「言われた数」と「料金表の語」を候補として列挙する（設計 docs/design/invoice-verify.md の (a)）。
 * 純粋な関数。API を呼ばない、入力を書き換えない、同じ入力なら同じ出力。
 * 読めない円（unparsedYen）は捨てずに候補にする。数を推測で作らない。
 * `verify.ts` は V4 で消すため、ここからは import しない（必要なものは写した）。
 */
import { type LedgerEntry, findEntry } from "../ledger/lookup";
import type { Transcript } from "../stt/types";

export type CandidateKind = "qty" | "unitPrice" | "total" | "amount" | "unparsedYen" | "item";

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
  /** item と unparsedYen は null。 */
  value: number | null;
  unit: string | null;
  /** total だけ。 */
  taxIncluded?: boolean;
  /** amount で、直前が「数＋単位＋で」のときのその数。 */
  impliedQty?: number;
  /** item で、findEntry で 1 つに決まるときの正式名。 */
  ledgerItem?: string;
};

/** 数量に付く単位。`verify.ts` の UNITS と同じ。長いものを先に置く。 */
const UNITS = ["セット", "箇所", "か所", "ヶ所", "本", "個", "台", "輪", "つ", "枚", "式", "回"];
const UNIT = `(?:${UNITS.join("|")})`;

const KANJI_DIGIT: Record<string, number> = {
  〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const KANJI_MULT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const KANJI_CHARS = "〇一二三四五六七八九十百千万";

function digitOf(c: string): number | undefined {
  if (c >= "0" && c <= "9") return Number(c);
  return KANJI_DIGIT[c];
}

/** 万より下の 1 区切り（「三百三十」「千百」「五」）。位取りとして崩れていれば null。 */
function parseSection(s: string): number | null {
  if (s === "") return null;
  let total = 0;
  let pending: number | null = null;
  let lastMult = Infinity;
  for (const c of s) {
    const m = KANJI_MULT[c];
    if (m !== undefined) {
      if (m >= lastMult) return null;
      total += (pending ?? 1) * m;
      pending = null;
      lastMult = m;
    } else {
      const d = digitOf(c);
      // 数字が 2 字続く（「二二十」）・位取りの中の〇は崩れとみなす
      if (d === undefined || d === 0 || pending !== null) return null;
      pending = d;
    }
  }
  return total + (pending ?? 0);
}

/**
 * 漢数字を含む並びを算用数字の文字列にする。読めなければ null（漢字のまま残す）。
 * 位の字が無ければ 1 字ずつの読み（「三三〇」→「330」）、あれば位取り（「三百三十」→「330」）。
 */
function readKanjiRun(run: string): string | null {
  if (!/[十百千万]/.test(run)) {
    let out = "";
    for (const c of run) {
      const d = digitOf(c);
      if (d === undefined) return null;
      out += String(d);
    }
    return out;
  }
  const parts = run.split("万");
  if (parts.length > 2) return null;
  if (parts.length === 2) {
    const hi = parseSection(parts[0]);
    if (hi === null) return null;
    const lo = parts[1] === "" ? 0 : parseSection(parts[1]);
    if (lo === null) return null;
    return String(hi * 10000 + lo);
  }
  const v = parseSection(run);
  return v === null ? null : String(v);
}

/**
 * 候補の文法の正規化。NFKC、漢数字の並び→算用数字、空白の除去の 3 つだけ。
 * 小数点・句読点・カンマは消さない。位取りとして崩れた漢数字は漢字のまま残す。
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(new RegExp(`[0-9${KANJI_CHARS}]+`, "g"), (run) => {
      if (!new RegExp(`[${KANJI_CHARS}]`).test(run)) return run;
      return readKanjiRun(run) ?? run;
    })
    .replace(/\s+/g, "");
}

type NumToken = { start: number; end: number; value: number };

/** 正規化後の文字列の中の数。「1,000」は 1 つの数、「33.0」は小数のまま。 */
function numberTokens(n: string): NumToken[] {
  const re = /\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\d)|\d+(?:\.\d+)?/g;
  return [...n.matchAll(re)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    value: Number(m[0].replace(/,/g, "")),
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
  const tokens = numberTokens(n);
  const byEnd = new Map(tokens.map((t) => [t.end, t]));
  /** unitPrice の「1＋単位」の「1」の位置。数量にしない。 */
  const perUnitOnes = new Set<number>();
  const mk = (kind: Raw["kind"], start: number, end: number, value: number | null, unit: string | null): Raw => ({
    kind, seg, start, end, text: n.slice(start, end), value, unit,
  });

  for (let i = n.indexOf("円"); i >= 0; i = n.indexOf("円", i + 1)) {
    const end = i + 1;
    const num = byEnd.get(i);
    if (!num) {
      let s = i;
      while (s > 0 && YEN_TRAIL.test(n[s - 1])) s--;
      out.push(mk("unparsedYen", s, end, null, null));
      continue;
    }
    const prefix = n.slice(0, num.start);

    // 「1＋単位＋（あたり）（は・が）（、）＋数＋円」
    const one = tokens.find((t) => t.end <= num.start && n.slice(t.start, t.end) === "1" && UNIT_PRICE_LINK.test(n.slice(t.end, num.start)));
    if (one) {
      perUnitOnes.add(one.start);
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

  for (const t of tokens) {
    const u = unitAt(n, t.end);
    if (u === null || perUnitOnes.has(t.start)) continue;
    const after = t.end + u.length;
    if (RANGE_MARKS.has(n[t.start - 1]) || RANGE_MARKS.has(n[after])) continue;
    out.push(mk("qty", t.start, after, t.value, u));
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
  qty: "q", unitPrice: "p", total: "t", amount: "a", unparsedYen: "u", item: "i",
};
const KIND_ORDER: CandidateKind[] = ["qty", "unitPrice", "total", "amount", "unparsedYen", "item"];

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
