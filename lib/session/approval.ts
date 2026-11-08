/**
 * 承認の言葉と、はい・いいえの語彙（W4）。語彙はここだけに置く。
 * 判定は、句読点と空白を除いた答えの全体との完全一致だけ。部分一致・含むかどうかでは判定しない（推測で埋めない）。
 */
import { normalizeText } from "../invoice/candidates";

/** 承認の言葉（#4 で「請求書頼む」に決まった）と表記ゆれ。normalizeText 後の形で書く。 */
export const APPROVAL_PHRASES = ["請求書頼む", "請求書たのむ", "せいきゅうしょ頼む", "せいきゅうしょたのむ"];

/** 文末の付け足し。各 1 回まで。「な」は「頼むな＝頼まないで」と取り違えるので入れない。 */
export const APPROVAL_SUFFIXES = ["じゃ", "ね", "よ"];

/** 前置き（父の相づち）。0〜1 回だけ許す。 */
export const APPROVAL_PREFIXES = ["んだ"];

export const YES_ANSWERS = ["はい", "はいそうです", "そうです", "そう", "んだ", "んだんだ", "合ってる", "合ってます"];
/** 「まいね」は「だめ・いけない」の意味で、やった・やらないのどちらとも取れるので入れない。 */
export const NO_ANSWERS = ["いいえ", "いや", "違う", "違います", "ちがう", "やった", "やりました"];

/**
 * 「X は何の数ですか」（使われない数）への、その数は関係ないという答え。全体一致だけ。
 * 「いいえ」「違う」は入れない（同じ質問の前半「脱着は4本ですか」への否定とも取れる）。
 */
export const UNRELATED_ANSWERS = ["関係ない", "関係無い", "かんけいない", "関係ねえ", "関係ね", "関係ないです"];

/**
 * 数・金額の答えの前後に許す語（相づちと文末）。各 1 回まで。ここに無い語が残れば答えは読まない。
 * 例: 「んだ、4本だ」「はい、550円です」「4本じゃ」。
 */
export const ANSWER_PREFIXES = ["んだ", "はい", "うん", "じゃ"];
export const ANSWER_SUFFIXES = ["です", "だ", "じゃ", "な", "ね", "よ"];

/** 答えの品目の語の後に許す助詞（「ゴムバルブは4本」）。 */
export const ITEM_PARTICLES = ["は", "も", "が"];

const PUNCT = /[。、！？!?,\s]/g;

/** normalizeText して句読点（。、！？!?,）と空白を除いた形。 */
export function bareAnswer(text: string): string {
  return normalizeText(text).replace(PUNCT, "");
}

/** tail が、付け足しを各 1 回までの任意の並びでちょうど作れるか。 */
export function suffixesOnly(tail: string, left: string[]): boolean {
  if (tail === "") return true;
  return left.some((s) => tail.startsWith(s) && suffixesOnly(tail.slice(s.length), left.filter((x) => x !== s)));
}

/** 前置き 0〜1 個＋承認の言葉＋付け足し 0 個以上（各 1 回まで）と、ちょうど一致するときだけ true。 */
export function isApproval(text: string): boolean {
  const b = bareAnswer(text);
  const heads = [b, ...APPROVAL_PREFIXES.filter((p) => b.startsWith(p)).map((p) => b.slice(p.length))];
  return heads.some((h) =>
    APPROVAL_PHRASES.some((p) => h.startsWith(p) && suffixesOnly(h.slice(p.length), APPROVAL_SUFFIXES)),
  );
}

export function isYes(text: string): boolean {
  return YES_ANSWERS.includes(bareAnswer(text));
}

export function isNo(text: string): boolean {
  return NO_ANSWERS.includes(bareAnswer(text));
}

export function isUnrelated(text: string): boolean {
  return UNRELATED_ANSWERS.includes(bareAnswer(text));
}

/** 「N で合っていますか」（数を確かめる質問）への肯定の語。normalizeText 後・句読点を除いた形。文末の「よ」「ね」は各 1 回まで。 */
export const AFFIRM_ANSWERS = [
  "合ってる",
  "合ってます",
  "合っています",
  "あってる",
  "あってます",
  "あっています",
  "はい",
  "んだ",
  "そう",
  "そうです",
  "ok",
  "それで",
];
const AFFIRM_SUFFIXES = ["よ", "ね"];

/** b が「肯定の語＋（よ・ね）」だけか。 */
function affirmOnly(b: string): boolean {
  return AFFIRM_ANSWERS.some((w) => b.startsWith(w) && suffixesOnly(b.slice(w.length), AFFIRM_SUFFIXES));
}

/** 前置き（はい・んだ・うん）0 個以上＋肯定の語＋（よ・ね）だけの返事か（「合ってます。」「はい、合ってるよ」）。 */
export function isAffirm(text: string): boolean {
  const b = bareAnswer(text).toLowerCase();
  return affirmOnly(b) || affirmOnly(stripPrefixes(b, ANSWER_PREFIXES));
}

/** b の頭から、前置きを各 1 回までの任意の並びで取り除けるだけ取り除いた残り。 */
function stripPrefixes(b: string, left: string[]): string {
  for (const p of left) {
    if (b.startsWith(p)) return stripPrefixes(b.slice(p.length), left.filter((x) => x !== p));
  }
  return b;
}

/**
 * 答えの文字列が「前置き＋（品目の語＋助詞）＋値＋付け足し」だけでできているか。
 * value は正規化後の文字列（normalizeText(text)）での値の候補の範囲。words は質問が名指しした品目の語（正規化後）。
 * affirm なら、値の後の「で合ってます」の類（「で」＋肯定の語＋よ・ね）も許す（数を確かめる質問への答え）。
 * 句読点と空白は無視する。ほかの語（別の品目・知らない単位・2 つ目の数）が残れば false。
 */
export function onlyValue(text: string, value: { start: number; end: number }, words: string[], affirm = false): boolean {
  const MARK = "\u0000";
  const n = normalizeText(text);
  let b = (n.slice(0, value.start) + MARK + n.slice(value.end)).replace(PUNCT, "");
  b = stripPrefixes(b, ANSWER_PREFIXES);
  const word = [...words].filter((w) => w !== "").sort((x, y) => y.length - x.length).find((w) => b.startsWith(w));
  if (word !== undefined) {
    b = b.slice(word.length);
    const particle = ITEM_PARTICLES.find((p) => b.startsWith(p));
    if (particle !== undefined) b = b.slice(particle.length);
  }
  if (!b.startsWith(MARK)) return false;
  const tail = b.slice(MARK.length);
  if (suffixesOnly(tail, ANSWER_SUFFIXES)) return true;
  // 数を確かめる質問への「4本で合ってます」: 値の後に「で」＋肯定の語（＋よ・ね）
  return affirm && tail.startsWith("で") && affirmOnly(tail.slice(1).toLowerCase());
}
