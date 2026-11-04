/**
 * 声の入口の振り分け（lib/session/voice.ts）と、声の返事・声の入口の route（answer-audio・voice）の検証。
 * 実 API は呼ばない（STT は globalThis.fetch を試験の中だけ差し替える。Claude は 127.0.0.1 の偽サーバー）。
 * 素材は架空の発話と架空の料金表。data/ は読まない。見るのは自分で作った一時フォルダの中だけ。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { enumerateCandidates } from "../lib/invoice/candidates";
import { ledgerEntries, parseLedgerBook } from "../lib/ledger/lookup";
import { type Extractor, startSession } from "../lib/session/run";
import { newSession, readSession, type Session, transition, writeSession } from "../lib/session/store";
import { answerUtterance, routeVoice } from "../lib/session/voice";
import type { Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const LEDGER_PATH = join(ROOT, "tests/fixtures/tire-ledger.json");
const ledger = ledgerEntries(parseLedgerBook(JSON.parse(readFileSync(LEDGER_PATH, "utf8"))));
const KEY = "sk-fake-key-値-voice";

const made: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nda-voice-route-"));
  made.push(d);
  return d;
}

let claude: Server;
const saved = {
  e: process.env.ELEVENLABS_API_KEY,
  g: process.env.GEMINI_API_KEY,
  a: process.env.ANTHROPIC_API_KEY,
  b: process.env.ANTHROPIC_BASE_URL,
};

before(async () => {
  // 偽の Claude: 明細 0 行を返す（新しい作業が作られたことだけを見る）
  claude = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg",
          type: "message",
          role: "assistant",
          model: "fake",
          content: [{ type: "text", text: JSON.stringify({ lines: [], negations: [] }) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => claude.listen(0, "127.0.0.1", r));
  const addr = claude.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${addr.port}`;
  process.env.NDA_LEDGER_PATH = LEDGER_PATH;
  process.env.NDA_SESSION_DIR = await tmp();
});

after(async () => {
  claude.closeAllConnections();
  claude.close();
  for (const d of made) await rm(d, { recursive: true, force: true });
  for (const [k, v] of [
    ["ELEVENLABS_API_KEY", saved.e],
    ["GEMINI_API_KEY", saved.g],
    ["ANTHROPIC_API_KEY", saved.a],
    ["ANTHROPIC_BASE_URL", saved.b],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 5, 9, 0, clock++));
let seq = 0;

/** 架空の「ゴムバルブも替えた。」: 数量を聞く作業（refs は手書き）。 */
const VALVE: Transcript = {
  recordingId: "valve-voice",
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: [{ startSec: 0, endSec: 3, speaker: null, text: "ゴムバルブも替えた。" }],
};
const fakeExtract: Extractor = async (t, l) => {
  const candidates = enumerateCandidates(t, l);
  const item = candidates.find((c) => c.kind === "item" && c.text === "ゴムバルブ");
  if (!item) throw new Error("候補が無い");
  return {
    candidates,
    lines: [
      { item: item.id, qty: null, unitPrice: null, amount: null, status: "done", evidence: [], correctedFrom: null, correctedTo: null },
    ],
    negations: [],
  };
};
const startValve = (dir: string, clockOf: () => Date = now) =>
  startSession({ dir, transcript: VALVE, ledger, extract: fakeExtract, now: clockOf, id: `v${seq++}` });
/** route は実際の時計で作業を作るので、最新の作業を比べる試験では少し待って時刻をずらす。 */
const tick = () => new Promise((r) => setTimeout(r, 5));

// --- 純粋な関数 ---

test("routeVoice: asking（質問中・承認待ち）だけが返事。無い・done・失敗の idle・途中の状態は新しい作業", async () => {
  const dir = await tmp();
  const asking = await startValve(dir);
  assert.equal(asking.status, "asking");
  assert.ok((asking.invoice?.confirmations.length ?? 0) > 0);
  assert.deepEqual(routeVoice(asking), { kind: "answer", id: asking.id });
  // 承認待ち（確認事項 0 件の asking）も返事
  const waiting: Session = { ...asking, invoice: asking.invoice && { ...asking.invoice, confirmations: [] }, questions: [] };
  assert.deepEqual(routeVoice(waiting), { kind: "answer", id: asking.id });
  const done = transition({ ...waiting, approved: true, approvedAt: now().toISOString() }, "done", now());
  assert.deepEqual(routeVoice(done), { kind: "new" });
  assert.deepEqual(routeVoice(null), { kind: "new" });
  const idle = newSession("idle-x", now());
  assert.deepEqual(routeVoice({ ...idle, error: "抽出に失敗しました（Error）" }), { kind: "new" });
  const thinking = transition(transition(idle, "listening", now()), "thinking", now());
  assert.deepEqual(routeVoice(thinking), { kind: "new" });
  const before = structuredClone(asking);
  routeVoice(asking);
  assert.deepEqual(asking, before);
});

test("answerUtterance: 1 発話はそのまま。複数はつなぎ、時刻は最初から最後まで、話者は全部同じときだけ残す。空は throw", () => {
  const t = (segs: Transcript["segments"]): Transcript => ({ recordingId: "r", vendor: "x", language: "ja", glossaryHint: false, segments: segs });
  const one = t([{ startSec: 0.2, endSec: 1, speaker: "speaker_0", text: "4本" }]);
  assert.deepEqual(answerUtterance(one), { startSec: 0.2, endSec: 1, speaker: "speaker_0", text: "4本" });
  const same = t([
    { startSec: 0.1, endSec: 1, speaker: "speaker_0", text: "請求書。" },
    { startSec: 1.2, endSec: 2, speaker: "speaker_0", text: "頼む" },
  ]);
  assert.deepEqual(answerUtterance(same), { startSec: 0.1, endSec: 2, speaker: "speaker_0", text: "請求書。頼む" });
  const mixed = t([
    { startSec: 0, endSec: 1, speaker: "speaker_0", text: "4本。" },
    { startSec: 1, endSec: 2, speaker: "speaker_1", text: "2本。" },
  ]);
  const before = structuredClone(mixed);
  assert.deepEqual(answerUtterance(mixed), { startSec: 0, endSec: 2, speaker: null, text: "4本。2本。" });
  assert.deepEqual(mixed, before);
  assert.throws(() => answerUtterance(t([])), /発話が無い/);
});

// --- route ---

/** 架空の WAV（無音、16kHz モノラル 16bit、1 秒）。 */
function silentWav(): Uint8Array {
  const dataSize = 16000 * 2;
  const buf = new Uint8Array(44 + dataSize);
  const v = new DataView(buf.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (buf[at + i] = c.charCodeAt(0)));
  put(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, dataSize, true);
  return buf;
}
const WAV = silentWav();

const form = (fields: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const file = () => new File([WAV as Uint8Array<ArrayBuffer>], "a.wav", { type: "audio/wav" });
const post = (path: string, fields: Record<string, string | Blob>) =>
  new Request(`http://localhost${path}`, { method: "POST", body: form(fields) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * STT の偽物を挟んで f を動かす。heard の次の文字を Scribe の 1 語・Gemini の本文として返す。
 * Scribe・Gemini 以外（偽の Claude）へはそのまま通す。
 */
async function withStt<T>(heard: string[], f: (calls: string[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (url.startsWith("https://api.elevenlabs.io/")) {
      calls.push("scribe");
      const text = heard.shift() ?? "";
      return json({ words: [{ text, start: 0.1, end: 0.8, type: "word", speaker_id: "speaker_0" }] });
    }
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      calls.push("gemini");
      return json({ steps: [{ type: "model_output", content: [{ type: "text", text: heard.shift() ?? "" }] }] });
    }
    return original(input, init);
  }) as typeof fetch;
  process.env.ELEVENLABS_API_KEY = KEY;
  process.env.GEMINI_API_KEY = KEY;
  try {
    return await f(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("answer-audio: 400・404・409・500・502、声の「4本」で数量が入り、声の「請求書頼む」で done。音声のファイルを残さない", async () => {
  const route = await import("../app/api/session/[id]/answer-audio/route");
  const dir = await tmp();
  process.env.NDA_SESSION_DIR = dir;
  const s = await startValve(dir);
  const p = `/api/session/${s.id}/answer-audio`;

  await withStt(["4本", "請求書頼む。"], async (calls) => {
    assert.equal((await route.POST(post(p, { file: file() }), ctx(s.id))).status, 400);
    assert.equal((await route.POST(post(p, { file: file(), vendor: "whisper" }), ctx(s.id))).status, 400);
    assert.equal((await route.POST(post(p, { vendor: "scribe" }), ctx(s.id))).status, 400);
    assert.equal((await route.POST(post(p, { file: file(), vendor: "scribe" }), ctx("none"))).status, 404);
    assert.equal((await route.POST(post(p, { file: file(), vendor: "scribe" }), ctx("../x"))).status, 404);
    await writeSession(dir, newSession("idle-a", now()));
    assert.equal((await route.POST(post(p, { file: file(), vendor: "scribe" }), ctx("idle-a"))).status, 409);
    // 作業が答えを受けられないなら STT を呼ばない
    assert.deepEqual(calls, []);

    // キーが無い: 500 で STT を呼ばない
    delete process.env.ELEVENLABS_API_KEY;
    const nokey = await route.POST(post(p, { file: file(), vendor: "scribe" }), ctx(s.id));
    assert.equal(nokey.status, 500);
    assert.deepEqual(calls, []);
    process.env.ELEVENLABS_API_KEY = KEY;

    const r1 = await route.POST(post(p, { file: file(), vendor: "scribe" }), ctx(s.id));
    const t1 = await r1.text();
    assert.equal(r1.status, 200, t1);
    assert.ok(!t1.includes(KEY));
    const a1 = await readSession(dir, s.id);
    assert.equal(a1?.status, "asking");
    assert.deepEqual(a1?.answers.at(-1)?.action, { kind: "setQty", value: 4, unit: "本" });
    assert.equal(a1?.answers.at(-1)?.provenance.quote, "4本");
    assert.equal(a1?.invoice?.confirmations.length, 0);

    const r2 = await route.POST(post(p, { file: file(), vendor: "scribe" }), ctx(s.id));
    assert.equal(r2.status, 200);
    const v2 = (await r2.json()) as { view: { state: string; approved: boolean; total: number | null } };
    assert.equal(v2.view.state, "done");
    assert.equal(v2.view.approved, true);
    assert.equal(v2.view.total, 1320);
    assert.equal((await route.POST(post(p, { file: file(), vendor: "scribe" }), ctx(s.id))).status, 409);
    assert.deepEqual(calls, ["scribe", "scribe"]);
  });

  // STT の失敗は 502、キーを返さない
  const s2 = await startValve(dir);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(`bad ${KEY}`, { status: 500 })) as typeof fetch;
  try {
    process.env.ELEVENLABS_API_KEY = KEY;
    const bad = await route.POST(post(p, { file: file(), vendor: "scribe" }), ctx(s2.id));
    assert.equal(bad.status, 502);
    assert.ok(!(await bad.text()).includes(KEY));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal((await readSession(dir, s2.id))?.answers.length, 0);

  // 自分のフォルダには <id>.json だけ（音声を保存しない）
  assert.deepEqual((await readdir(dir)).filter((n) => !n.endsWith(".json")), []);
});

test("voice: 作業が無ければ新しい作業（201）、最新が asking なら返事（200）、done の後はまた新しい作業。Gemini でも同じ", async () => {
  const route = await import("../app/api/session/voice/route");
  const dir = await tmp();
  process.env.NDA_SESSION_DIR = dir;

  await withStt(["タイヤ交換したい", "4本", "請求書頼む", "次の作業", "4本"], async (calls) => {
    assert.equal((await route.POST(post("/api/session/voice", { file: file() }))).status, 400);

    // 無い → 新しい作業
    const r0 = await route.POST(post("/api/session/voice", { file: file(), vendor: "scribe" }));
    const t0 = await r0.text();
    assert.equal(r0.status, 201, t0);
    assert.ok(!t0.includes(KEY));
    const first = (JSON.parse(t0) as { id: string }).id;
    assert.equal((await readSession(dir, first))?.transcript?.segments[0]?.text, "タイヤ交換したい");

    // 最新が asking の作業（数量を聞いている）→ その返事
    await tick();
    const valve = await startValve(dir, () => new Date());
    await tick();
    const r1 = await route.POST(post("/api/session/voice", { file: file(), vendor: "scribe" }));
    assert.equal(r1.status, 200);
    assert.deepEqual((await readSession(dir, valve.id))?.answers.at(-1)?.action, { kind: "setQty", value: 4, unit: "本" });
    // 承認待ち → 承認の言葉で done
    const r2 = await route.POST(post("/api/session/voice", { file: file(), vendor: "scribe" }));
    assert.equal(((await r2.json()) as { view: { state: string } }).view.state, "done");

    // done の後 → 新しい作業。前の作業は変わらない
    await tick();
    const r3 = await route.POST(post("/api/session/voice", { file: file(), vendor: "gemini" }));
    assert.equal(r3.status, 201);
    const third = (await r3.json()) as { id: string };
    assert.notEqual(third.id, valve.id);
    assert.equal((await readSession(dir, valve.id))?.answers.length, 2);

    // 新しい作業（明細 0 行）も asking なので、次の声はその返事になる（Gemini）。0 行なので話の続きとして文字起こしに足して抽出し直す
    const r4 = await route.POST(post("/api/session/voice", { file: file(), vendor: "gemini" }));
    assert.equal(r4.status, 200);
    const t4 = await readSession(dir, third.id);
    assert.equal(t4?.answers.length, 1);
    assert.equal(t4?.answers[0].action.kind, "continue");
    assert.deepEqual(
      t4?.transcript?.segments.map((x) => x.text),
      ["次の作業", "4本"],
    );
    assert.deepEqual(calls, ["scribe", "scribe", "scribe", "gemini", "gemini"]);
  });
  assert.deepEqual((await readdir(dir)).filter((n) => !n.endsWith(".json")), []);
});
