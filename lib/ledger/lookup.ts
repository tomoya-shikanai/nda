import { readFile } from "node:fs/promises";
import type { LedgerResult } from "../karte/schema";

export type LedgerEntry = {
  item: string;
  aliases: string[];
  price: number;
  unit: string;
  source: string; // どこから来た値か（父のソフト書き出し／手入力／参考資料）
};

/**
 * 料金表に無い言い方で、料金表の 2 つ以上の品目のどれか分からない言葉（「タイヤ交換」→ 脱着か組替か）。
 * choices は料金表の正式名。
 */
export type Ambiguity = { word: string; choices: string[] };

/** 料金表のファイルの中身。ファイルは品目の配列だけ（前の形）か、{ items, ambiguous } のどちらでもよい。 */
export type LedgerBook = { items: LedgerEntry[]; ambiguous: Ambiguity[] };

const isEntry = (e: unknown): e is LedgerEntry => {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.item === "string" &&
    Array.isArray(o.aliases) &&
    o.aliases.every((a) => typeof a === "string") &&
    typeof o.price === "number" &&
    typeof o.unit === "string" &&
    typeof o.source === "string"
  );
};

const isAmbiguity = (a: unknown): a is Ambiguity => {
  if (typeof a !== "object" || a === null) return false;
  const o = a as Record<string, unknown>;
  return typeof o.word === "string" && Array.isArray(o.choices) && o.choices.every((c) => typeof c === "string");
};

/** ファイルの中身を料金表の本にする。形が違えば throw（品目を黙って捨てない）。 */
export function parseLedgerBook(raw: unknown): LedgerBook {
  const obj = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const items = Array.isArray(raw) ? raw : obj?.items;
  const ambiguous = obj?.ambiguous ?? [];
  if (!Array.isArray(items) || !items.every(isEntry)) throw new Error("料金表の品目の形が違う");
  if (!Array.isArray(ambiguous) || !ambiguous.every(isAmbiguity)) throw new Error("料金表の言い換えの形が違う");
  return { items, ambiguous };
}

/**
 * 言い換えの言葉を、その選択肢の品目の別名に足した料金表（入力は書き換えない）。
 * 2 つ以上の品目の別名になるので、findEntry は 1 つに決めず、price.ts が「別名があいまい」の確認事項にする。
 * 料金表に当たる選択肢が 2 つ未満の言い換えは足さない（1 つの品目に黙って決めない）。
 */
export function ledgerEntries(book: LedgerBook): LedgerEntry[] {
  const out = book.items.map((e) => ({ ...e, aliases: [...e.aliases] }));
  for (const a of book.ambiguous) {
    const targets = [...new Set(a.choices.map(itemKey))]
      .map((k) => out.filter((e) => itemKey(e.item) === k))
      .filter((hits) => hits.length === 1)
      .map((hits) => hits[0]);
    if (itemKey(a.word) === "" || targets.length < 2) continue;
    for (const e of targets) if (!e.aliases.some((x) => itemKey(x) === itemKey(a.word))) e.aliases.push(a.word);
  }
  return out;
}

/** 料金表の本を読む。ファイルが無い・読めない・形が違うときは空。 */
export async function loadLedgerBook(path: string): Promise<LedgerBook> {
  try {
    return parseLedgerBook(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return { items: [], ambiguous: [] };
  }
}

/** 照らすための料金表（言い換えを別名に足したもの）。 */
export async function loadLedger(path: string): Promise<LedgerEntry[]> {
  return ledgerEntries(await loadLedgerBook(path));
}

/** 料金表の置き場（環境変数 NDA_LEDGER_PATH、既定は data/ledger.json）。 */
export function ledgerPath(): string {
  return process.env.NDA_LEDGER_PATH ?? "data/ledger.json";
}

/**
 * あいまいな言葉の選択肢（料金表の項目）。正式名か別名に当たる項目が 2 つ以上あるときだけ、料金表の順で返す。
 * 1 つに決まる・当たらないなら空。
 */
export function choicesOf(ledger: LedgerEntry[], word: string): LedgerEntry[] {
  return isAmbiguous(ledger, word)
    ? ledger.filter((e) => itemKey(e.item) === itemKey(word) || e.aliases.some((a) => itemKey(a) === itemKey(word)))
    : [];
}

/**
 * 選択肢を父に呼ぶときの短い名前: ほかの項目と共有しない最初の別名（「脱着」）。無ければ正式名。
 */
export function shortName(ledger: LedgerEntry[], e: LedgerEntry): string {
  const own = e.aliases.find((a) => ledger.filter((x) => x.aliases.some((y) => itemKey(y) === itemKey(a))).length === 1);
  return own ?? e.item;
}

/** 台帳の品目名の比べ方。空白と大文字小文字だけ無視する。 */
export const itemKey = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/**
 * 品目名に当たる台帳の項目を 1 つだけ返す。正式名の一致を別名より優先する。
 * 2 つ以上の項目に当たる（あいまい）なら null。配列の順で 1 つを選ばない。
 */
export function findEntry(ledger: LedgerEntry[], item: string): LedgerEntry | null {
  const key = itemKey(item);
  if (!key) return null;
  const byName = ledger.filter((e) => itemKey(e.item) === key);
  if (byName.length > 0) return byName.length === 1 ? byName[0] : null;
  const byAlias = ledger.filter((e) => e.aliases.some((a) => itemKey(a) === key));
  return byAlias.length === 1 ? byAlias[0] : null;
}

/**
 * 品目名があいまいか。findEntry が null で、正式名か別名に当たる項目が 2 つ以上あるとき true。
 * 料金表に 1 つも当たらない品目は false。
 */
export function isAmbiguous(ledger: LedgerEntry[], item: string): boolean {
  const key = itemKey(item);
  if (!key || findEntry(ledger, item) !== null) return false;
  const hits = ledger.filter((e) => itemKey(e.item) === key || e.aliases.some((a) => itemKey(a) === key));
  return hits.length >= 2;
}

/** 台帳に無ければ found:false。推測で埋めない。あいまいな品目名も found:false。 */
export function lookup(ledger: LedgerEntry[], item: string): LedgerResult {
  const hit = findEntry(ledger, item);
  if (!hit) return { item, found: false, price: null, unit: null, source: null };
  return { item, found: true, price: hit.price, unit: hit.unit, source: hit.source };
}

/** 画面に出す料金表（言える作業の一覧）。出所の欄は出さない。 */
export type PublicLedger = {
  items: { item: string; aliases: string[]; unit: string; price: number }[];
  ambiguous: Ambiguity[];
};

/** 料金表の本から、画面に出してよい欄だけを取り出す（入力は書き換えない）。言い換えは料金表に当たる選択肢が 2 つ以上のものだけ。 */
export function publicLedger(book: LedgerBook): PublicLedger {
  const merged = ledgerEntries(book);
  return {
    items: book.items.map((e) => ({ item: e.item, aliases: [...e.aliases], unit: e.unit, price: e.price })),
    ambiguous: book.ambiguous
      .filter((a) => choicesOf(merged, a.word).length >= 2)
      .map((a) => ({ word: a.word, choices: choicesOf(merged, a.word).map((e) => e.item) })),
  };
}
