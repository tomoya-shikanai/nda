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
export const NO_ANSWERS = ["いいえ", "いや", "違う", "違います", "ちがう", "まいね", "やった", "やりました"];

const PUNCT = /[。、！？!?,\s]/g;

/** normalizeText して句読点（。、！？!?,）と空白を除いた形。 */
export function bareAnswer(text: string): string {
  return normalizeText(text).replace(PUNCT, "");
}

/** tail が、付け足しを各 1 回までの任意の並びでちょうど作れるか。 */
function suffixesOnly(tail: string, left: string[]): boolean {
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
