import { readFile } from "node:fs/promises";
import type { LedgerResult } from "../karte/schema";

export type LedgerEntry = {
  item: string;
  aliases: string[];
  price: number;
  unit: string;
  source: string; // どこから来た値か（父のソフト書き出し／手入力／参考資料）
};

export async function loadLedger(path: string): Promise<LedgerEntry[]> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LedgerEntry[];
  } catch {
    return [];
  }
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

/** 台帳に無ければ found:false。推測で埋めない。あいまいな品目名も found:false。 */
export function lookup(ledger: LedgerEntry[], item: string): LedgerResult {
  const hit = findEntry(ledger, item);
  if (!hit) return { item, found: false, price: null, unit: null, source: null };
  return { item, found: true, price: hit.price, unit: hit.unit, source: hit.source };
}
