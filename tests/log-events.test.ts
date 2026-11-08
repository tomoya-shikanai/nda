/**
 * 出来事の記録（lib/log、docs/logging.md）: 置き場が無ければ記録しない、形の合わない行は捨てる、書けなくても本体を止めない、
 * 偽の事務所での一周で出来事がそろう、名前・4 桁・said・label・答えの言葉が記録に入らない、集計。
 * 素材は架空の発話・架空の料金表・架空の客の一覧。抽出は偽物（API を呼ばない）。.env は読まない。見るのは自分で作った一時フォルダだけ。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { CustomerList } from "../lib/customer/match";
import { enumerateCandidates } from "../lib/invoice/candidates";
import { ledgerEntries, parseLedgerBook } from "../lib/ledger/lookup";
import { errorKind, eventsFile, localDate, logEvent } from "../lib/log/events";
import { sessionEvents, unreadCode } from "../lib/log/session";
import { concerns, formatSummary, stat, summarize, summarizeDay } from "../lib/log/summary";
import { processBox } from "../lib/office/fake";
import { BOX_MARKER, folderBox, type OfficeLink } from "../lib/office/link";
import { handleOfficeReply } from "../lib/office/reply";
import type { ToFactory } from "../lib/office/schema";
import { answerWith, startFromAudio } from "../lib/session/routes";
import { type Extractor, replySession, startSession } from "../lib/session/run";
import { readSession } from "../lib/session/store";
import type { Segment, Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = ledgerEntries(parseLedgerBook(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8"))));
const customers = CustomerList.parse(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/customers.json"), "utf8")));
const TOKEN = "test-token-log-0123";

const made: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nda-log-"));
  made.push(d);
  return d;
}
const KEYS = ["NDA_LOG_DIR", "NDA_SESSION_DIR", "NDA_OFFICE_TOKEN", "ELEVENLABS_API_KEY", "GEMINI_API_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
before(() => {
  process.env.NDA_OFFICE_TOKEN = TOKEN;
});
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const fict = (texts: string[]): Transcript => ({
  recordingId: "log-1",
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: texts.map((text, i) => ({ startSec: i * 4, endSec: i * 4 + 3, speaker: null, text })),
});
const say = (text: string): Segment => ({ startSec: 0, endSec: 2, speaker: "speaker_0", text });

/** 偽の抽出: 料金表の品目ごとに 1 行、同じ発話の数量。 */
const extractor: Extractor = async (t, l) => {
  const candidates = enumerateCandidates(t, l);
  const lines = candidates
    .filter((c) => c.kind === "item" && c.ledgerItem !== undefined)
    .map((item) => ({
      item: item.id,
      qty: candidates.find((c) => c.kind === "qty" && c.seg === item.seg)?.id ?? null,
      unitPrice: null,
      amount: null,
      status: "done" as const,
      evidence: [],
      correctedFrom: null,
      correctedTo: null,
    }));
  return { candidates, lines, negations: [], usage: { inputTokens: 1200, outputTokens: 80 } };
};

const post = async (m: ToFactory) => {
  const r = await handleOfficeReply(
    new Request("http://localhost/api/office/reply", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(m),
    }),
  );
  assert.equal(r.status, 200, await r.clone().text());
};

async function env() {
  const logs = await tmp();
  const dir = await tmp();
  const box = join(await tmp(), "in");
  await mkdir(box, { recursive: true });
  await writeFile(join(box, BOX_MARKER), "");
  process.env.NDA_LOG_DIR = logs;
  process.env.NDA_SESSION_DIR = dir;
  const office: OfficeLink = { box: folderBox(box, { requireMount: false }), timeoutMs: 1000 };
  return { logs, dir, box, office };
}

const readLog = async (logs: string) => {
  const raw = (await Promise.all((await readdir(logs)).map((n) => readFile(join(logs, n), "utf8")))).join("");
  return { raw, rows: raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
};

/** 記録に入ってはいけない言葉（架空の客の名前・4 桁・label・車種・答えの言葉・発話・品目名・said の欄名）。 */
const FORBIDDEN = ["仮田", "1111", "架空の軽トラ", "cust-001", "car-cust-001", "請求書頼む", "4本かな", "脱着", "タイヤ", "お願いします", "said", "label", "quote"];

test("置き場（NDA_LOG_DIR）が無ければ記録しない。あれば日ごとの JSONL に 1 行。書けなくても投げない", async () => {
  const logs = await tmp();
  delete process.env.NDA_LOG_DIR;
  logEvent("tts", { ms: 10, ok: true, error: null });
  assert.deepEqual(await readdir(logs), []);

  process.env.NDA_LOG_DIR = logs;
  const now = new Date(2026, 10, 8, 9, 0, 0);
  logEvent("tts", { ms: 10, ok: true, error: null }, now);
  const rows = (await readFile(eventsFile(logs, now), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(localDate(now), "2026-11-08");
  assert.deepEqual(rows, [{ t: now.toISOString(), kind: "tts", ms: 10, ok: true, error: null }]);

  // 置き場がファイル（書けない）でも投げない
  const file = join(logs, "blocker");
  await writeFile(file, "");
  process.env.NDA_LOG_DIR = join(file, "sub");
  assert.doesNotThrow(() => logEvent("tts", { ms: 1, ok: true, error: null }));
});

test("形の合わない出来事は捨てて log.invalid（種類だけ）: 余計な欄・自由な文字列・不正な id・種類名でない失敗", async () => {
  const logs = await tmp();
  process.env.NDA_LOG_DIR = logs;
  const now = new Date();
  const bad: [string, unknown][] = [
    ["tts", { ms: 1, ok: true, error: null, said: ["仮田さんの1111"] }],
    ["route.reject", { route: "answer", sessionId: "仮田さんの1111", reason: "stale" }],
    ["session.answer", { sessionId: "s1", questionReason: "qty", action: "unread", unreadReason: "仮田さんの1111が読めない" }],
    ["stt", { vendor: "scribe", purpose: "start", audioSec: 1, ms: 1, ok: false, error: "fetch failed: 仮田 1111" }],
    ["office.put", { sessionId: "s1", message: "customer.query", messageId: "m1", attempt: null, ms: -1, ok: true, error: null }],
  ];
  for (const [k, f] of bad) logEvent(k as "tts", f as never, now);
  const { raw, rows } = await readLog(logs);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.of]),
    bad.map(([k]) => ["log.invalid", k]),
  );
  assert.ok(!raw.includes("仮田") && !raw.includes("1111"));
  assert.equal(errorKind(new TypeError("x 仮田")), "TypeError");
  assert.equal(errorKind("仮田"), "string");
  assert.equal(unreadCode("抽出に失敗しました（APIError）"), "抽出に失敗");
  assert.equal(unreadCode("数が無い"), "数が無い");
  assert.equal(unreadCode("仮田さん"), "other");
});

test("偽の事務所で一周: 作業・抽出・照合・答え・承認・依頼・結果・二重の返しが記録され、名前・4 桁・said・label・答えの言葉は入らない", async () => {
  const { logs, dir, box, office } = await env();
  const s0 = await startSession({
    dir,
    transcript: fict(["脱着4本。お願いします。えっと。仮田さんの1111。"]),
    ledger,
    extract: extractor,
    office,
    id: "log-s1",
  });
  await processBox({ box, customers, post });
  const s1 = await readSession(dir, s0.id);
  assert.ok(s1);
  const s2 = await replySession({ dir, session: s1, utterance: say("4本かな"), ledger, office });
  assert.equal(s2.answers.at(-1)?.action.kind, "unread");
  const s3 = await replySession({ dir, session: s2, utterance: say("請求書頼む"), ledger, office });
  assert.equal(s3.status, "sent");
  // 事務所が結果を返す。同じ結果がもう一度届く（duplicate）
  const sent: ToFactory[] = [];
  await processBox({
    box,
    customers,
    post: async (m) => {
      sent.push(m);
      await post(m);
    },
  });
  await post(sent[0]);
  assert.equal((await readSession(dir, s0.id))?.status, "entered");

  const { raw, rows } = await readLog(logs);
  for (const w of FORBIDDEN) assert.ok(!raw.includes(w), `記録に「${w}」が入っている`);
  const kinds = rows.map((r) => r.kind);
  for (const k of ["session.created", "session.transition", "extract", "office.put", "office.reply", "session.query", "session.answer", "session.approved", "session.office"]) {
    assert.ok(kinds.includes(k), `${k} が無い`);
  }
  assert.ok(!kinds.includes("log.invalid"), raw);
  const of = (k: string) => rows.filter((r) => r.kind === k);
  assert.deepEqual(
    of("session.transition").map((r) => `${r.from}>${r.to}`),
    ["null>idle", "idle>listening", "listening>thinking", "thinking>drafting", "drafting>asking", "asking>done", "done>sending", "sending>sent", "sent>entered"],
  );
  const [ex] = of("extract");
  assert.equal(ex.ok, true);
  assert.equal(ex.model, null, "偽の抽出はモデル名なし");
  assert.equal(ex.inputTokens, 1200);
  assert.equal(ex.lines, 1);
  assert.deepEqual(
    of("office.put").map((r) => [r.message, r.ok]),
    [
      ["customer.query", true],
      ["invoice.request", true],
    ],
  );
  assert.deepEqual(
    of("office.reply").map((r) => [r.message, r.result, r.answer]),
    [
      ["customer.answer", "accepted", "found"],
      ["invoice.result", "accepted", null],
      ["invoice.result", "duplicate", null],
    ],
  );
  assert.ok(typeof of("office.reply")[0].msSinceSent === "number");
  assert.deepEqual(
    of("session.answer").map((r) => [r.action, r.unreadReason]),
    [
      ["unread", "聞いている質問が無い"],
      ["approve", null],
    ],
  );
  assert.equal(of("session.office")[0].outcome, "entered");
  assert.equal(of("session.approved")[0].answers, 2);

  // 集計
  const s = await summarizeDay(logs, localDate(new Date()));
  assert.equal(s.sessions, 1);
  assert.equal(s.approved, 1);
  assert.equal(s.unread, 1);
  assert.equal(s.officeReplies["invoice.result:duplicate"], 1);
  assert.equal(s.officeRoundTrip.query.n, 1);
});

test("入口: キーが無い文字起こしは stt の noKey、無い作業への答えは route.reject。音声の秒数は WAV から", async () => {
  const { logs } = await env();
  delete process.env.ELEVENLABS_API_KEY;
  // 1 秒の無音の WAV（16kHz・16bit・モノラル）
  const pcm = 16000 * 2;
  const wav = Buffer.alloc(44 + pcm);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm, 40);
  const r = await startFromAudio({ vendor: "scribe", file: new Blob([wav], { type: "audio/wav" }) });
  assert.equal(r.status, 500);
  assert.equal((await answerWith("no-such", say("仮田さんの1111"))).status, 404);
  assert.equal((await answerWith("../x", say("仮田"))).status, 404);
  const { raw, rows } = await readLog(logs);
  assert.deepEqual(rows.map((x) => [x.kind, x.error ?? x.reason]), [
    ["stt", "noKey"],
    ["route.reject", "notFound"],
    ["route.reject", "notFound"],
  ]);
  assert.equal(rows[0].audioSec, 1);
  assert.equal(rows[2].sessionId, null, "形の不正な id は記録しない");
  assert.ok(!raw.includes("仮田") && !raw.includes("1111"));
});

test("作業の差: 抽出の失敗で答えが置き換わっても拾う", () => {
  const base = {
    id: "s1",
    status: "drafting",
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:01.000Z",
    history: [{ status: "asking", at: "x" }, { status: "drafting", at: "y" }],
    questions: [],
    answers: [{ questionIndex: 0, action: { kind: "continue", offsetSec: 3 } }],
    approved: false,
    approvedAt: null,
    customerRequired: false,
    customerQuery: null,
    office: null,
  } as never;
  const back = {
    ...(base as object),
    status: "asking",
    history: [...(base as { history: object[] }).history, { status: "asking", at: "z" }],
    answers: [{ questionIndex: 0, action: { kind: "unread", reason: "抽出に失敗しました（APIError）" } }],
  } as never;
  const ev = sessionEvents(base, back);
  assert.deepEqual(
    ev.map((e) => [e.kind, "to" in e.fields ? e.fields.to : "unreadReason" in e.fields ? e.fields.unreadReason : null]),
    [
      ["session.transition", "asking"],
      ["session.answer", "抽出に失敗"],
    ],
  );
});

test("集計: 中央値・最大、unread の率と理由、起動語の conf の分布、409、気になる点", () => {
  assert.deepEqual(stat([3, 1, 2, 10]), { n: 4, median: 2.5, max: 10 });
  assert.deepEqual(stat([]), { n: 0, median: null, max: null });
  const ev = [
    { kind: "session.created" },
    { kind: "session.created" },
    { kind: "session.approved", msFromCreated: 60000 },
    { kind: "extract", ok: true, ms: 4000, inputTokens: 100, outputTokens: 10, questionReasons: { qty: 2, customer: 1 } },
    { kind: "extract", ok: false, ms: 500, error: "APIError", inputTokens: null, outputTokens: null, questionReasons: {} },
    ...["数が無い", "数が無い", "答えに余計な語がある"].map((r) => ({ kind: "session.answer", questionReason: "qty", action: "unread", unreadReason: r })),
    { kind: "session.answer", questionReason: "qty", action: "setQty", unreadReason: null },
    { kind: "session.answer", questionReason: null, action: "approve", unreadReason: null },
    { kind: "stt", ok: true, ms: 2000, audioSec: 4 },
    { kind: "stt", ok: false, ms: 100, audioSec: 4, error: "noKey" },
    { kind: "session.query", status: "expired", retryReason: null },
    { kind: "office.reply", message: "customer.answer", result: "stale" },
    { kind: "log.invalid", of: "tts" },
  ];
  const li = [
    { kind: "wake", conf: 0.97, accepted: true },
    { kind: "wake", conf: 0.85, accepted: false },
    { kind: "wake", conf: 0.82, accepted: false },
    { kind: "record", sec: 3, spoke: true },
    { kind: "record", sec: 5, spoke: false },
    { kind: "send", ms: 900, status: 409, result: "conflict" },
    { kind: "send", ms: 800, status: 201, result: "ok" },
  ];
  const s = summarize(ev, li);
  assert.equal(s.sessions, 2);
  assert.equal(s.approveMs.median, 60000);
  assert.equal(s.questions, 3);
  assert.equal(s.answers, 4, "承認は答えに数えない");
  assert.equal(s.unreadRate, 0.75);
  assert.deepEqual(s.unreadReasons, { 数が無い: 2, 答えに余計な語がある: 1 });
  assert.deepEqual(s.failures, { "stt:noKey": 1, "extract:APIError": 1 });
  assert.deepEqual(s.wake.buckets, { "0.95-": 1, "0.8-0.9": 2 });
  assert.equal(s.conflicts409, 1);
  assert.equal(s.record.silent, 1);
  assert.equal(s.invalidLines, 1);
  const c = concerns(s).join("\n");
  assert.match(c, /unread が 75%.*「数が無い」/);
  assert.match(c, /期限切れ/);
  assert.match(c, /409/);
  assert.match(c, /下限 0.9/);
  const text = formatSummary("2026-11-08", s);
  assert.match(text, /^# 2026-11-08/);
  assert.match(text, /## 気になる点/);
});
