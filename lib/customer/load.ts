/**
 * 客と車の一覧を読む（#45）。一覧はリポジトリに入れない。置き場は NDA_CUSTOMERS_PATH。
 * 環境変数が無ければ機能は無効（null）。置き場があって読めない・形が違うときは空の一覧（照合は決まらず、承認できない。黙って無効にしない）。
 */
import { readFile } from "node:fs/promises";
import { type Customer, CustomerList } from "./match";

export async function loadCustomers(path = process.env.NDA_CUSTOMERS_PATH): Promise<Customer[] | null> {
  if (!path) return null;
  try {
    return CustomerList.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return [];
  }
}
