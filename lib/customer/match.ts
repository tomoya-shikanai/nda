/**
 * 客と車の照合（#45）と伏せ字。名前（name か kana）とナンバーの下 4 桁の両方が、一覧の同じ 1 件に合うときだけ結び付ける。
 * 工場は一覧を持たない（#25。照合は事務所が行う）。工場が使うのは一覧なしの伏せ字（maskCustomerInfo）と、問い合わせる文の取り出し（plateSentences）。
 * 一覧つきの照合（identifyCustomer）は、Mac の中の偽の事務所（lib/office/fake.ts）が架空の一覧で使う。
 * 純粋な関数。API を呼ばない（照合は Claude に任せない）、入力を書き換えない。画面のコードからは型だけを使う。
 *
 * 比べ方: 1 字ずつ NFKC にし、カタカナをひらがなに、漢数字の 1 字（〇一二…九）を算用数字にそろえ、空白・「-」を飛ばした文字列で探す
 * （元の文字の位置を覚えておき、伏せ字は元の文に当てる）。名前の語は name と kana の全体と、空白の前（姓）。
 *
 * 伏せ字（照合が決まっても決まらなくても、一覧の有無にかかわらず。客の情報を Claude にも保存にも渡さない）:
 * - 一覧のどれかの名前の語。
 * - 前後が数字でなく「円」が続かない 4 桁の数（算用数字・全角・漢数字の 1 字ずつ）。一覧に無いナンバーも伏せる。
 * - 「さん」「様」「さま」の直前の名前らしい並び（字の種類をまたぎ、助詞・句読点・数字で止める。一覧に無い客の名前も伏せる）。
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

/** 名前に使う字（漢字・々・ヶ・ひらがな・カタカナ・ー・ラテン文字・全角英字）。字の種類が変わっても続ける。 */
const NAME_CHAR = /[\p{Script=Han}々〆ヶ\u3041-\u3096\u30a1-\u30fa\u30fcｦ-ﾟA-Za-zＡ-Ｚａ-ｚ]/u;
const isNameChar = (c: string | undefined) => c !== undefined && c !== "様" && NAME_CHAR.test(c);
/** 敬称から遡るとき、ここで止める助詞（その字は名前に入れない）。 */
const PARTICLES = new Set(["は", "が", "の", "と", "に", "を", "も", "で", "へ", "や"]);

/** 敬称。名前でない語（「たくさん」「様子」「様々」「さまざま」）は除く。 */
const HONORIFIC = /さん|様|さま/g;
const NOT_HONORIFIC = ["たくさん", "沢山", "様子", "様々", "さまざま"];
/** 敬称の前でも名前でない語（遡った並び全体がこれ（頭の「お」は任意）なら伏せない・一覧外の名前に数えない）。 */
const NOT_NAMES = ["お客", "客", "皆", "みな", "奥", "父", "母", "兄", "姉", "おじ", "おば", "じい", "ばあ"];

/**
 * 敬称の直前の名前らしい並び。名前に使う字を、字の種類をまたいで遡る（「山田ヨシ子」「佐々木」「Tanaka」）。
 * 止めるのは、名前に使う字でないもの（句読点・数字など）・文頭・助詞（漢字・カタカナ・英字の後の「の」など）・前の敬称の終わり。
 * 間の空白・「・」1 字は、前後が名前の字なら続きとみなす。伏せすぎる側に倒す。無ければ null。
 */
function nameBefore(text: string, honorificAt: number): Span | null {
  // 敬称の直前の空白（半角・全角、続いても）は飛ばしてから名前の字を探す（「山田 さん」「山田　様」）
  let at = honorificAt;
  while (at > 0 && /\s/.test(text[at - 1])) at--;
  // 助詞とみなすのは、直前が漢字・カタカナ・英字のとき（「山田の」）。ひらがなの続き・文頭の「や」「の」は名前の字（「やまだ」「のぞみ」）。
  // ただし助詞の後ろ、敬称までがひらがなだけなら、その字は名前の一部とみなして止めない（「山田はなこ」「佐藤のぞみ」。伏せすぎる側）
  const hiraganaOnly = (j: number) => /^[\u3041-\u3096]+$/.test(text.slice(j + 1, at));
  const particle = (j: number) =>
    PARTICLES.has(text[j]) && isNameChar(text[j - 1]) && !/[\u3041-\u3096]/.test(text[j - 1]) && !hiraganaOnly(j);
  const stop = (j: number) => !isNameChar(text[j]) || particle(j) || /(さん|様|さま)$/.test(text.slice(0, j + 1));
  if (stop(at - 1)) return null;
  let i = at - 1;
  for (;;) {
    if (i - 1 >= 0 && !stop(i - 1)) i--;
    else if (/[\s・]/.test(text[i - 1] ?? "") && i - 2 >= 0 && !stop(i - 2)) i -= 2;
    else break;
  }
  return { start: i, end: honorificAt };
}

/** 敬称の前の名前らしい部分（伏せる範囲）。 */
function honorificNames(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(HONORIFIC)) {
    const at = m.index ?? 0;
    if (NOT_HONORIFIC.some((w) => [...text.matchAll(new RegExp(w, "g"))].some((x) => (x.index ?? 0) <= at && at < (x.index ?? 0) + w.length))) continue;
    const sp = nameBefore(text, at);
    if (sp === null) continue;
    const word = text.slice(sp.start, sp.end);
    if (NOT_NAMES.some((w) => word === w || word === `お${w}`)) continue;
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
export function identifyCustomer(texts: string[], customers: Customer[], extra?: (Span & { mask: string })[][]): Identified {
  const plates = new Set(customers.map((c) => c.plate4));
  const named = new Set<string>();
  const saidPlates = new Set<string>();
  let blocked = false;
  const out = texts.map((text, ti) => {
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
    spans.push(...(extra?.[ti] ?? []));
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

/** 数字の間に挟まってもよい区切り（詰める）。読点も入れる（「12、34」「一、二、三、四」。「2、3、4、5本」まで伏せるのは許す）。 */
const DIGIT_GAP = /[\s\-‐－−ー・,，.、]/;

/**
 * 文の中の数字の並び。NFKC にし、漢数字の 1 字を算用数字にそろえる。並びは数字の塊（区切りの無い数字）を、
 * 数字の間の空白・「-」・読点などの区切りをまたいでつないだもの（「12 34」「1 2 3 4」「一二三四」）。
 * 並びの後（空白を飛ばして）に「円」が続くときは、最後の塊だけを値段とし（yen）、それより前の塊は値段に入れない
 * （「田中 1234 1650円」の 1234 をナンバーとして見る）。
 */
function digitRuns(sentence: string): { chunks: string[]; yen: boolean }[] {
  const chars = [...sentence].map((c) => {
    const k = KANJI_DIGITS.indexOf(c);
    return k >= 0 ? String(k) : c.normalize("NFKC");
  });
  const isDigit = (c: string | undefined) => c !== undefined && /^[0-9]$/.test(c);
  const out: { chunks: string[]; yen: boolean }[] = [];
  let i = 0;
  while (i < chars.length) {
    if (!isDigit(chars[i])) {
      i++;
      continue;
    }
    const chunks: string[] = [];
    let j = i;
    let last = i;
    for (;;) {
      let chunk = "";
      while (isDigit(chars[j])) {
        chunk += chars[j];
        last = j;
        j++;
      }
      chunks.push(chunk);
      let k = j;
      while (k < chars.length && DIGIT_GAP.test(chars[k])) k++;
      if (k === j || !isDigit(chars[k])) break;
      j = k;
    }
    let k = last + 1;
    while (k < chars.length && /\s/.test(chars[k])) k++;
    out.push({ chunks, yen: chars[k] === "円" });
    i = last + 1;
  }
  return out;
}

/** 値段でない部分の塊（円が続く並びは最後の塊を除く）。 */
const plateChunks = (r: { chunks: string[]; yen: boolean }) => (r.yen ? r.chunks.slice(0, -1) : r.chunks);

/** 文の 4 桁の数（ナンバー）の候補: 値段でない部分をつないだ並びと、塊のうち、ちょうど 4 桁のもの。 */
function plates4(sentence: string): string[] {
  const out: string[] = [];
  for (const r of digitRuns(sentence)) {
    const cs = plateChunks(r);
    for (const c of [cs.join(""), ...cs]) if (c.length === 4 && !out.includes(c)) out.push(c);
  }
  return out;
}

/** ナンバーかもしれない数（値段でない部分をつないだ並びか塊が 4 桁以上）。伏せ字はこれで決める（伏せすぎる側）。 */
const hasPlateLike = (sentence: string) =>
  digitRuns(sentence).some((r) => {
    const cs = plateChunks(r);
    return cs.join("").length >= 4 || cs.some((c) => c.length >= 4);
  });

type Sentence = { ti: number; start: number; end: number; text: string };

/** 発話を文に分ける（。！？と発話の区切り）。end は句点の前。空の文は入れない。 */
function sentencesOf(texts: string[]): Sentence[] {
  const out: Sentence[] = [];
  texts.forEach((t, ti) => {
    for (const m of t.matchAll(SENTENCE)) {
      if (m[0] === "") continue;
      const start = m.index ?? 0;
      const body = m[0].replace(/[。！？!?]$/, "");
      if (body.trim() === "") continue;
      out.push({ ti, start, end: start + body.length, text: body });
    }
  });
  return out;
}

/**
 * 事務所に問い合わせる文（docs/design/pi-office.md §3）: 4 桁の数を含む文と、その直前の文を、伏せ字にする前の原文で返す
 * （「田中です。1234です。」の名前も届くように）。作業の話のほかの文は事務所に行かない。4 桁が 1 つも無ければ said も plate4 も空。
 */
export function plateSentences(texts: string[]): { said: string[]; plate4: string[] } {
  const ss = sentencesOf(texts);
  const pick = new Set<number>();
  const plate4: string[] = [];
  ss.forEach((x, k) => {
    const ps = plates4(x.text);
    if (ps.length === 0) return;
    if (k > 0) pick.add(k - 1);
    pick.add(k);
    for (const p of ps) if (!plate4.includes(p)) plate4.push(p);
  });
  const said = [...pick].sort((a, b) => a - b).map((k) => ss[k].text.trim());
  return { said, plate4 };
}

/**
 * ナンバーかもしれない数（円が続かない 4 桁以上）を含む文と、その直前・直後の文を丸ごと伏せる範囲（発話ごと）。
 * 品目の語があっても例外にしない（抜けた作業は聞き返しで補う）。敬称の無い姓（「田中、ナンバーは、1234。」「1234、田中。」）を一覧なしで伏せるため。
 * 前後の文は発話をまたぐ。ナンバーから 2 文以上離れた敬称の無い姓は伏せられない（docs/anonymization.md の既知の限界）。
 */
function plateSentenceSpans(texts: string[]): (Span & { mask: string })[][] {
  const ss = sentencesOf(texts);
  const hit = new Set<number>();
  ss.forEach((x, k) => {
    if (!hasPlateLike(x.text)) return;
    for (const j of [k - 1, k, k + 1]) if (j >= 0 && j < ss.length) hit.add(j);
  });
  const out: (Span & { mask: string })[][] = texts.map(() => []);
  for (const k of hit) out[ss[k].ti].push({ start: ss[k].start, end: ss[k].end, mask: MASK_PLATE });
  return out;
}

/**
 * 一覧なしの伏せ字。工場はこれだけを使う（一覧は事務所にある）。敬称の前の名前らしい部分と 4 桁に加え、
 * ナンバーかもしれない数を含む文とその前後の文を丸ごと伏せる。
 */
export function maskCustomerInfo(texts: string[]): string[] {
  return identifyCustomer(texts, [], plateSentenceSpans(texts)).texts;
}
