/**
 * 配管の検証。Claude は偽サーバーで置き換える。モデルの品質は検証しない。
 * 確かめるのは「捏造を構造で止める」部分と、スクリプトが最後まで通ること。
 * 素材は架空で、実案件・証明には使わない。
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import type { Karte, KarteDraft } from "../lib/karte/schema";
import { verifyDraft } from "../lib/karte/verify";
import { lookup } from "../lib/ledger/lookup";
import { citationFailures, karteView } from "../lib/son/ask";
import type { Transcript } from "../lib/stt/types";

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules/.bin/tsx");

const transcript: Transcript = {
  recordingId: "rec1",
  vendor: "test",
  language: "ja",
  glossaryHint: false,
  segments: [
    { startSec: 0, endSec: 4, speaker: "father", text: "今この音出てるけど、" },
    { startSec: 4, endSec: 8, speaker: "father", text: "ブッシュは次の車検まで持つ。" },
  ],
};
const prov = {
  recordingId: "rec1",
  startSec: 4,
  endSec: 8,
  speaker: "father" as const,
  quote: "次の車検まで持つ",
};
const draft: KarteDraft = {
  summary: "異音の確認",
  symptoms: [],
  checks: [{ order: 1, what: "ブッシュ", how: null, result: null, provenance: prov }],
  senses: [],
  decision: {
    action: "defer",
    target: "ブッシュ",
    reasons: [{ text: "車検まで持つ", kind: "father_observation", provenance: prov }],
    conditions: [],
  },
  workLines: [{ item: "ブッシュ交換", qty: 1, unit: "式", note: null }],
  missingConditions: [{ what: "錆の程度", whyNeeded: "判断が変わる" }],
  glossary: [],
};
const karte = (over: Partial<Karte> = {}): Karte => ({
  ...draft,
  id: "k1",
  recordingId: "rec1",
  createdAt: "2026-11-02T00:00:00Z",
  status: "approved",
  ledger: [],
  verificationFailures: [],
  preregistration: null,
  question: null,
  ...over,
});

test("後検証: 文字起こしに実在する引用は合格", () => {
  assert.deepEqual(verifyDraft(draft, transcript), []);
});

test("後検証: 文字起こしに無い引用は不合格", () => {
  const bad = structuredClone(draft);
  bad.checks[0].provenance.quote = "錆がひどいから替える";
  assert.match(verifyDraft(bad, transcript)[0], /文字起こしに無い/);
});

test("後検証: 時刻が離れた引用は不合格", () => {
  const bad = structuredClone(draft);
  bad.checks[0].provenance = { ...prov, startSec: 30, endSec: 32 };
  assert.match(verifyDraft(bad, transcript)[0], /文字起こしに無い/);
});

test("後検証: 話者情報の無い録音で話者を推定すると不合格", () => {
  const noSpeaker = {
    ...transcript,
    segments: transcript.segments.map((s) => ({ ...s, speaker: null })),
  };
  assert.match(verifyDraft(draft, noSpeaker).join(), /話者を father と推定/);
});

test("台帳: 無い値は found:false で価格を埋めない", () => {
  assert.deepEqual(lookup([], "ブッシュ交換"), {
    item: "ブッシュ交換",
    found: false,
    price: null,
    unit: null,
    source: null,
  });
});

test("息子の問い: 未承認の回答はモデルに渡さない", () => {
  const q = {
    arm: "claude" as const,
    fired: true,
    text: "どこまで錆びたら替える？",
    targetCondition: "錆",
    skippedReason: null,
    answer: "未承認の回答",
  };
  assert.equal(karteView(karte({ question: { ...q, answerApproved: null } })).approvedCondition, null);
  assert.equal(karteView(karte({ question: { ...q, answerApproved: false } })).approvedCondition, null);
  assert.equal(
    karteView(karte({ question: { ...q, answerApproved: true } })).approvedCondition?.answer,
    "未承認の回答",
  );
});

test("息子の問い: 出所と一致しない引用と未承認カルテの引用を弾く", () => {
  const ok = { karteId: "k1", recordingId: "rec1", startSec: 4, endSec: 8, quote: "次の車検まで持つ" };
  assert.deepEqual(citationFailures([ok], [karte()]), []);
  assert.equal(citationFailures([{ ...ok, quote: "作り話" }], [karte()]).length, 1);
  assert.equal(citationFailures([ok], [karte({ status: "draft" })]).length, 1);
});

// --- スクリプトを偽サーバーで最後まで通す ---
let server: Server;
let cwd: string;
let env: NodeJS.ProcessEnv;
let sonAnswer: unknown;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const system = String(JSON.parse(body).system);
      const output = system.includes("書記")
        ? draft
        : system.includes("一問だけ")
          ? {
              decisionRecorded: true,
              conditionMissing: true,
              notFillable: true,
              shortAnswerable: true,
              targetCondition: "錆",
              question: "どこまで錆びたら替えますか？",
              skippedReason: null,
            }
          : sonAnswer;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg",
          type: "message",
          role: "assistant",
          model: "fake",
          content: [{ type: "text", text: JSON.stringify(output) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  cwd = await mkdtemp(join(tmpdir(), "nda-"));
  await mkdir(join(cwd, "data"));
  await writeFile(join(cwd, "t.json"), JSON.stringify(transcript));
  await commitPreregistration(cwd);
  env = { ...process.env, ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${addr.port}` };
});
after(() => server.close());

// 一時フォルダを git リポジトリにして、架空の事前登録をコミットする
async function commitPreregistration(dir: string) {
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs/preregistration.md"), "# 架空の事前登録\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("add", "docs/preregistration.md");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "prereg");
  return git("rev-parse", "HEAD").toString().trim();
}

const script = (name: string, ...args: string[]) =>
  exec(TSX, [join(ROOT, "scripts", name), ...args], { cwd, env });
const scriptIn = (dir: string, name: string, ...args: string[]) =>
  exec(TSX, [join(ROOT, "scripts", name), ...args], { cwd: dir, env });

test("配管: 3 腕→承認→息子の問い→範囲外で停止", async () => {
  const ran = await script("run.ts", "t.json", "--arm", "all");
  assert.match(ran.stdout, /後検証 合格/);
  assert.match(ran.stdout, /事前登録 [0-9a-f]{7}/);
  assert.match(ran.stdout, /一問\[extract\].*発火せず/);
  assert.match(ran.stdout, /一問\[fixed\].*逆の判断/);
  assert.match(ran.stdout, /一問\[claude\].*どこまで錆びたら/);

  // 未承認の間は止まる
  assert.match((await script("ask.ts", "どこから？")).stdout, /まいね。まだ父さ聞いでね.*0 件/);

  await script("approve.ts", "t-claude", "んだ", "--answer", "穴が開いたら替える");
  const saved = JSON.parse(await readFile(join(cwd, "data/kartes/t-claude.json"), "utf8"));
  assert.equal(saved.status, "approved");
  assert.match(saved.preregistration, /^[0-9a-f]{40}$/); // 承認で書き戻しても消えない
  assert.equal(saved.question.answerApproved, true);

  sonAnswer = {
    answerable: true,
    answer: "ブッシュから",
    checkOrder: ["ブッシュ"],
    cited: [{ karteId: "t-claude", recordingId: "rec1", startSec: 4, endSec: 8, quote: "次の車検まで持つ" }],
    whyNot: null,
  };
  const answered = await script("ask.ts", "どこから？");
  assert.match(answered.stdout, /ブッシュから/);
  assert.match(answered.stdout, /原音 rec1 4-8s/);

  // モデルが出所を捏造したら止まる
  sonAnswer = {
    ...(sonAnswer as object),
    cited: [{ karteId: "t-claude", recordingId: "rec1", startSec: 4, endSec: 8, quote: "作り話" }],
  };
  assert.match((await script("ask.ts", "どこから？")).stdout, /まいね。まだ父さ聞いでね.*一致しない/);
});

test("配管: 後検証に落ちたカルテは承認できない", async () => {
  const k = karte({ id: "bad", status: "draft", verificationFailures: ["引用が無い"] });
  await writeFile(join(cwd, "data/kartes/bad.json"), JSON.stringify(k));
  await assert.rejects(script("approve.ts", "bad", "んだ"), /承認できない/);
});

test("配管: 不正な腕の指定は実行前に止まる", async () => {
  await assert.rejects(script("run.ts", "t.json", "--arm", "nope"), /usage/);
});

test("事前登録: 未コミットの変更があると評価を始めない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nda-prereg-"));
  await writeFile(join(dir, "t.json"), JSON.stringify(transcript));
  await commitPreregistration(dir);
  await writeFile(join(dir, "docs/preregistration.md"), "# 出力を見たあとで書き換えた\n");
  await assert.rejects(scriptIn(dir, "run.ts", "t.json", "--arm", "all"), /未コミットの変更/);
});

test("事前登録: git の外やコミット前では評価を始めない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nda-prereg-"));
  await writeFile(join(dir, "t.json"), JSON.stringify(transcript));
  await assert.rejects(scriptIn(dir, "run.ts", "t.json", "--arm", "all"), /確かめられない/);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  await assert.rejects(scriptIn(dir, "run.ts", "t.json", "--arm", "all"), /コミットされていない/);
});

test("事前登録: 1 腕だけの試し回しは事前登録を求めない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nda-prereg-"));
  await mkdir(join(dir, "data"));
  await writeFile(join(dir, "t.json"), JSON.stringify(transcript));
  const ran = await scriptIn(dir, "run.ts", "t.json", "--arm", "extract");
  assert.match(ran.stdout, /後検証 合格/);
  const saved = JSON.parse(await readFile(join(dir, "data/kartes/t-extract.json"), "utf8"));
  assert.equal(saved.preregistration, null);
});
