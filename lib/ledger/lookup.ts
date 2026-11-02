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

/** 台帳に無ければ found:false。推測で埋めない。 */
export function lookup(ledger: LedgerEntry[], item: string): LedgerResult {
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const key = norm(item);
  const hit = ledger.find((e) => norm(e.item) === key || e.aliases.some((a) => norm(a) === key));
  if (!hit) return { item, found: false, price: null, unit: null, source: null };
  return { item, found: true, price: hit.price, unit: hit.unit, source: hit.source };
}
