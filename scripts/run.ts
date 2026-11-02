/**
 * 配管: 文字起こし JSON → 分離 → 台帳照合 → 一問（腕を指定）→ カルテ JSON 保存
 * 使い方: pnpm tsx scripts/run.ts data/transcripts/<id>.json --arm claude [--photo path]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { loadTranscript } from "../lib/stt/manual";
import { separate } from "../lib/karte/separate";
import { loadLedger, lookup } from "../lib/ledger/lookup";
import { selectQuestion, type Arm } from "../lib/karte/question";
import { Karte } from "../lib/karte/schema";

const args = process.argv.slice(2);
const transcriptPath = args[0];
const arm = (args[args.indexOf("--arm") + 1] as Arm) || "claude";
const photo = args.includes("--photo") ? args[args.indexOf("--photo") + 1] : null;
if (!transcriptPath) {
  console.error("usage: tsx scripts/run.ts <transcript.json> --arm extract|fixed|claude [--photo p]");
  process.exit(1);
}

const t0 = Date.now();
const t = await loadTranscript(transcriptPath);
const draft = await separate(t, { photoPath: photo });
const t1 = Date.now();
const ledger = await loadLedger("data/ledger.json");
const ledgerResults = draft.workLines.map((w) => lookup(ledger, w.item));
const q = await selectQuestion(draft, arm);
const t2 = Date.now();

const karte = Karte.parse({
  ...draft,
  id: `${basename(transcriptPath, ".json")}-${arm}`,
  recordingId: t.recordingId,
  createdAt: new Date().toISOString(),
  status: "draft",
  ledger: ledgerResults,
  question: { ...q, answer: null, answerApproved: null },
});
await mkdir("data/kartes", { recursive: true });
const out = `data/kartes/${karte.id}.json`;
await writeFile(out, JSON.stringify(karte, null, 2));

console.log(`保存: ${out}`);
console.log(`分離 ${(t1 - t0) / 1000}s / 一問 ${(t2 - t1) / 1000}s`);
console.log(`要約: ${karte.summary}`);
console.log(`判断: ${karte.decision.action} ${karte.decision.target}`);
console.log(`確かめた順: ${karte.checks.map((c) => `${c.order}.${c.what}`).join(" → ")}`);
console.log(`台帳: ${ledgerResults.map((r) => `${r.item}=${r.found ? r.price : "未確認"}`).join(", ")}`);
console.log(`一問[${arm}]: ${q.fired ? q.text : `発火せず（${q.skippedReason}）`}`);
