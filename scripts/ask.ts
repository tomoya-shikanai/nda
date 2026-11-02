/**
 * 息子の問い: 承認済みカルテだけで答える。無ければ止まる。
 * 使い方: pnpm tsx scripts/ask.ts "客がゴトゴト言うと言っている。父ならどこから確かめる？"
 */
import { readdir, readFile } from "node:fs/promises";
import { Karte } from "../lib/karte/schema";
import { ask, STOP_MESSAGE } from "../lib/son/ask";

const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error("usage: tsx scripts/ask.ts <問い>");
  process.exit(1);
}
const files = (await readdir("data/kartes").catch(() => [])).filter((f) => f.endsWith(".json"));
const approved: Karte[] = [];
for (const f of files) {
  const k = Karte.parse(JSON.parse(await readFile(`data/kartes/${f}`, "utf8")));
  if (k.status === "approved") approved.push(k);
}
const a = await ask(question, approved);
if (!a.answerable) {
  console.log(`${STOP_MESSAGE}（${a.whyNot ?? "根拠なし"}）`);
  process.exit(0);
}
console.log(a.answer);
console.log(`確かめる順: ${a.checkOrder.join(" → ")}`);
for (const c of a.cited) console.log(`  原音 ${c.recordingId} ${c.startSec}-${c.endSec}s 「${c.quote}」`);
