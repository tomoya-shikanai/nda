/**
 * 客と車の照合（#45）。名前（name か kana）とナンバーの下 4 桁の両方が、一覧の同じ 1 件に合うときだけ結び付ける。
 * 純粋な関数。API を呼ばない（照合は Claude に任せない）、入力を書き換えない。画面のコードからは型だけを使う。
 *
 * 比べ方: 1 字ずつ NFKC にし、カタカナをひらがなに、漢数字の 1 字（〇一二…九）を算用数字にそろえ、空白・「-」を飛ばした文字列で探す
 * （元の文字の位置を覚えておき、伏せ字は元の文に当てる）。名前の語は name と kana の全体と、空白の前（姓）。
 *
 * 伏せ字（照合が決まっても決まらなくても、一覧の有無にかかわらず。客の情報を Claude にも保存にも渡さない）:
 * - 一覧のどれかの名前の語。
 * - 前後が数字でなく「円」が続かない 4 桁の数（算用数字・全角・漢数字の 1 字ずつ）。一覧に無いナンバーも伏せる。
 * - 「さん」「様」「さま」の直前の、同じ字の種類（漢字・ひらがな・カタカナ）の並び（名前らしい部分。一覧に無い客の名前も伏せる）。
 *
 * 決めないとき（customerId は null。候補をどこにも出さない）: 名前だけ・下 4 桁だけ・2 件以上に合う・合わない、
 * 一覧の名前を含む文に否定・訂正の合図がある（「見本さんじゃなくて」）、一覧の名前と同じ発話に一覧に無いさん付けの名前がある。
 */
import { z } from "zod";
import { CORRECTION_CUES, NEGATION_CUES } from "../invoice/resolve";

export const Customer = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kana: z.string().min(1),
  plate4: z.string().regex(/^[0-9]{4}$/),
  car: z.string(),
});
export type Customer = z.infer<typeof Customer>;
export const CustomerList = z.array(Customer);

/** 伏せ字。数字・品目の語・数量の候補にならない文字。 */
export const MASK_NAME = "＊＊";
export const MASK_PLATE = "＊＊＊＊";

const SKIP = /[\s\-‐－−ー]/;

const KANJI_DIGITS = "〇一二三四五六七八九";

/** カタカナ → ひらがな、漢数字の 1 字 → 算用数字（長音「ー」は飛ばす文字に入れる）。 */
function hira(c: string): string {
  const k = KANJI_DIGITS.indexOf(c);
  if (k >= 0) return String(k);
  const code = c.charCodeAt(0);
  return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : c;
}

/** 比べるための文字列と、各文字の元の位置。 */
function fold(text: string): { s: string; at: number[] } {
  let s = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (SKIP.test(c)) continue;
    for (const d of c.normalize("NFKC")) {
      if (SKIP.test(d)) continue;
      s += hira(d).toLowerCase();
      at.push(i);
    }
  }
  return { s, at };
}

const foldWord = (w: string) => fold(w).s;

/** 名前の語（name・kana の全体と姓）。比べる形。 */
export function nameWords(c: Customer): string[] {
  const words = [c.name, c.kana, c.name.split(/\s+/)[0], c.kana.split(/\s+/)[0]].map(foldWord).filter((w) => w.length >= 2);
  return [...new Set(words)];
}

type Span = { start: number; end: number };

export type Identified = {
  /** 伏せ字にした発話の文。並びは入力と同じ。 */
  texts: string[];
  /** 名前と下 4 桁の両方が同じ 1 件に合ったときだけ、その客の id。 */
  customerId: string | null;
};

type Script = "han" | "hira" | "kata";

function scriptOf(c: string | undefined): Script | null {
  if (c === undefined) return null;
  if (/\p{Script=Han}/u.test(c) && c !== "様") return "han";
  if (/[\u3041-\u3096]/.test(c)) return "hira";
  if (/[\u30a1-\u30fa\u30fcｦ-ﾟ]/.test(c)) return "kata";
  return null;
}

/** 敬称。名前でない語（「たくさん」「様子」「様々」「さまざま」）は除く。 */
const HONORIFIC = /さん|様|さま/g;
const NOT_HONORIFIC = ["たくさん", "沢山", "様子", "様々", "さまざま"];
/** 敬称の前でも名前でない語。伏せない・一覧外の名前に数えない。 */
const NOT_NAMES = new Set(["客", "お客", "皆", "みな", "奥", "父", "母", "兄", "姉", "おじ", "おば", "じい", "ばあ"]);

/** 敬称の直前の、同じ字の種類の並び（間の空白・「・」1 字は続きとみなす）。無ければ null。 */
function nameBefore(text: string, at: number): Span | null {
  const script = scriptOf(text[at - 1]);
  if (script === null) return null;
  let i = at - 1;
  for (;;) {
    if (scriptOf(text[i - 1]) === script) i--;
    else if (/[\s・]/.test(text[i - 1] ?? "") && scriptOf(text[i - 2]) === script) i -= 2;
    else break;
  }
  return { start: i, end: at };
}

/** 敬称の前の名前らしい部分（伏せる範囲）。 */
function honorificNames(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(HONORIFIC)) {
    const at = m.index ?? 0;
    if (NOT_HONORIFIC.some((w) => [...text.matchAll(new RegExp(w, "g"))].some((x) => (x.index ?? 0) <= at && at < (x.index ?? 0) + w.length))) continue;
    const sp = nameBefore(text, at);
    if (sp === null) continue;
    const word = text.slice(sp.start, sp.end).replace(/^お/, "");
    if (NOT_NAMES.has(word) || NOT_NAMES.has(text.slice(sp.start, sp.end))) continue;
    out.push(sp);
  }
  return out;
}

const SENTENCE = /[^。！？!?]*[。！？!?]?/g;
const CUES = [...NEGATION_CUES, ...CORRECTION_CUES];

/** 範囲を含む文（。！？で区切る）に否定・訂正の合図があるか。 */
function cuedSentence(text: string, sp: Span): boolean {
  for (const m of text.matchAll(SENTENCE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (m[0] === "" || sp.start >= end || sp.end <= start) continue;
    if (CUES.some((w) => m[0].replace(/\s/g, "").includes(w))) return true;
  }
  return false;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/**
 * 発話の文（1 つ以上）から客を探し、名前らしい部分と 4 桁の数を伏せ字にする（決め方と伏せ方は冒頭の注）。
 */
export function identifyCustomer(texts: string[], customers: Customer[]): Identified {
  const plates = new Set(customers.map((c) => c.plate4));
  const named = new Set<string>();
  const saidPlates = new Set<string>();
  let blocked = false;
  const out = texts.map((text) => {
    const f = fold(text);
    const spans: (Span & { mask: string })[] = [];
    const nameHits: Span[] = [];
    for (const c of customers) {
      for (const w of nameWords(c)) {
        for (let i = f.s.indexOf(w); i >= 0; i = f.s.indexOf(w, i + 1)) {
          const sp = { start: f.at[i], end: f.at[i + w.length - 1] + 1 };
          named.add(c.id);
          nameHits.push(sp);
          spans.push({ ...sp, mask: MASK_NAME });
          if (cuedSentence(text, sp)) blocked = true;
        }
      }
    }
    for (const sp of honorificNames(text)) {
      spans.push({ ...sp, mask: MASK_NAME });
      // 一覧の名前と同じ発話に、一覧に無いさん付けの名前がある（「新規の山田さん」）
      if (nameHits.length > 0 && !nameHits.some((h) => overlaps(h, sp))) blocked = true;
    }
    for (const m of f.s.matchAll(/[0-9]+/g)) {
      const i = m.index ?? 0;
      if (m[0].length !== 4 || f.s[i + 4] === "円") continue;
      if (plates.has(m[0])) saidPlates.add(m[0]);
      spans.push({ start: f.at[i], end: f.at[i + 3] + 1, mask: MASK_PLATE });
    }
    return mask(text, spans);
  });
  const hits = customers.filter((c) => named.has(c.id) && saidPlates.has(c.plate4));
  return { texts: out, customerId: !blocked && hits.length === 1 ? hits[0].id : null };
}

/** 重なる範囲はまとめ、後ろから伏せ字に置き換える。 */
function mask(text: string, spans: (Span & { mask: string })[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: (Span & { mask: string })[] = [];
  for (const sp of sorted) {
    const last = merged.at(-1);
    if (last && sp.start < last.end) {
      last.end = Math.max(last.end, sp.end);
      if (sp.mask === MASK_PLATE) last.mask = MASK_PLATE;
    } else merged.push({ ...sp });
  }
  let s = text;
  for (const sp of merged.reverse()) s = s.slice(0, sp.start) + sp.mask + s.slice(sp.end);
  return s;
}
