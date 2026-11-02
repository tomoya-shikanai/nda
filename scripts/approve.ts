/**
 * 父の裁定を記録する。「んだ」で承認、「まいね」で否認。息子の問いは承認済みだけを使う。
 * 使い方: pnpm tsx scripts/approve.ts <karteId> んだ|まいね [--answer "一問への父の回答"]
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Karte } from "../lib/karte/schema";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { answer: { type: "string" } },
});
const [id, verdict] = positionals;
if (!id || (verdict !== "んだ" && verdict !== "まいね")) {
  console.error('usage: tsx scripts/approve.ts <karteId> んだ|まいね [--answer "回答"]');
  process.exit(1);
}

const path = `data/kartes/${id}.json`;
const k = Karte.parse(JSON.parse(await readFile(path, "utf8")));
const approve = verdict === "んだ";

if (approve && k.verificationFailures.length > 0) {
  console.error(`後検証の不合格があるので承認できない:\n  ${k.verificationFailures.join("\n  ")}`);
  process.exit(2);
}
if (values.answer !== undefined && !k.question?.fired) {
  console.error("一問が発火していないカルテに回答は記録できない");
  process.exit(1);
}

k.status = approve ? "approved" : "rejected";
if (k.question?.fired && values.answer !== undefined) {
  k.question.answer = values.answer;
  k.question.answerApproved = approve;
}
await writeFile(path, JSON.stringify(k, null, 2));
console.log(`${id}: ${k.status}`);
