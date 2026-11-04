/**
 * 配管: 文字起こし JSON → 分離 → 後検証 → 台帳照合 → 一問 → カルテ JSON 保存
 * 使い方: pnpm tsx scripts/run.ts data/transcripts/<id>.json --arm extract|fixed|claude|all [--photo path]
 * --arm all は同じ分離結果で 3 腕を回す（腕の比較を分離のばらつきから切り離す）。
 */
import "../lib/env-auto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { loadTranscript } from "../lib/stt/manual";
import { separate } from "../lib/karte/separate";
import { verifyDraft } from "../lib/karte/verify";
import { loadLedger, lookup } from "../lib/ledger/lookup";
import { selectQuestion, type Arm } from "../lib/karte/question";
import { Karte } from "../lib/karte/schema";
import { committedPreregistration } from "../lib/eval/prereg";

const ALL_ARMS: Arm[] = ["extract", "fixed", "claude"];
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { arm: { type: "string", default: "claude" }, photo: { type: "string" } },
});
const transcriptPath = positionals[0];
const arms = values.arm === "all" ? ALL_ARMS : ALL_ARMS.filter((a) => a === values.arm);
if (!transcriptPath || arms.length === 0) {
  console.error("usage: tsx scripts/run.ts <transcript.json> --arm extract|fixed|claude|all [--photo p]");
  process.exit(1);
}

// 3 腕の比較は評価なので、事前登録がコミット済みでなければ Claude を呼ぶ前に止める
const preregistration = values.arm === "all" ? await committedPreregistration() : null;
if (preregistration) console.log(`事前登録 ${preregistration.slice(0, 7)}`);

const t0 = Date.now();
const t = await loadTranscript(transcriptPath);
const draft = await separate(t, { photoPath: values.photo ?? null });
const t1 = Date.now();
const failures = verifyDraft(draft, t);
const ledger = await loadLedger("data/ledger.json");
const ledgerResults = draft.workLines.map((w) => lookup(ledger, w.item));

console.log(`分離 ${(t1 - t0) / 1000}s`);
console.log(`要約: ${draft.summary}`);
console.log(`判断: ${draft.decision.action} ${draft.decision.target}`);
console.log(`確かめた順: ${draft.checks.map((c) => `${c.order}.${c.what}`).join(" → ")}`);
console.log(`台帳: ${ledgerResults.map((r) => `${r.item}=${r.found ? r.price : "未確認"}`).join(", ")}`);
console.log(failures.length ? `後検証 不合格 ${failures.length} 件:\n  ${failures.join("\n  ")}` : "後検証 合格");

await mkdir("data/kartes", { recursive: true });
for (const arm of arms) {
  const started = Date.now();
  const q = await selectQuestion(draft, arm);
  const karte = Karte.parse({
    ...draft,
    id: `${basename(transcriptPath, ".json")}-${arm}`,
    recordingId: t.recordingId,
    createdAt: new Date().toISOString(),
    status: "draft",
    ledger: ledgerResults,
    verificationFailures: failures,
    preregistration,
    question: { ...q, answer: null, answerApproved: null },
  });
  const out = `data/kartes/${karte.id}.json`;
  await writeFile(out, JSON.stringify(karte, null, 2));
  console.log(`一問[${arm}] ${(Date.now() - started) / 1000}s: ${q.fired ? q.text : `発火せず（${q.skippedReason}）`}`);
  console.log(`保存: ${out}`);
}
