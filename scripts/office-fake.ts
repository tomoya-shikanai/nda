/**
 * 偽の事務所を起動する（Mac の中だけで「話す → 照合 → 承認 → entered」を一周させる。lib/office/fake.ts）。
 * 使い方: NDA_OFFICE_BOX=<受け箱> NDA_OFFICE_TOKEN=<合言葉> NDA_FACTORY_URL=http://127.0.0.1:3100 pnpm office:fake
 * 客の一覧は架空の tests/fixtures/customers.json（NDA_FAKE_CUSTOMERS で変えられる）。実の一覧は渡さない。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CustomerList } from "../lib/customer/match";
import { poster, processBox } from "../lib/office/fake";
import { BOX_MARKER } from "../lib/office/link";

const box = process.env.NDA_OFFICE_BOX;
const token = process.env.NDA_OFFICE_TOKEN;
if (!box || !token) {
  console.error("NDA_OFFICE_BOX と NDA_OFFICE_TOKEN を渡してください");
  process.exit(2);
}
const factory = process.env.NDA_FACTORY_URL ?? "http://127.0.0.1:3000";
const customersPath = process.env.NDA_FAKE_CUSTOMERS ?? join(import.meta.dirname, "..", "tests", "fixtures", "customers.json");
const customers = CustomerList.parse(JSON.parse(await readFile(customersPath, "utf8")));
const post = poster(factory, token);
// 本物の事務所と同じく、受け箱と目印（mount が外れていないことの確かめ）を事務所側が置く
await mkdir(box, { recursive: true });
await writeFile(join(box, BOX_MARKER), "nda office box\n", "utf8");

console.log(`偽の事務所: 受け箱 ${box} を見張り、${factory} に返します（Ctrl-C で止める）`);
for (;;) {
  try {
    const n = await processBox({ box, customers, post });
    if (n > 0) console.log(`${n} 件に答えた`);
  } catch (e) {
    console.error(`答えられなかった（${e instanceof Error ? e.message : String(e)}）`);
  }
  await new Promise((r) => setTimeout(r, 200));
}
