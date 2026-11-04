/**
 * 文字起こし → 明細と質問 → 保存（lib/session/run.ts）、モニター用の JSON（lib/session/view.ts）、route handler の検証。
 * 素材は架空の文字起こし（tire-transcripts.json）と架空の料金表。data/ は読まない。Claude は偽サーバーで置き換える。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { type Candidate, enumerateCandidates } from "../lib/invoice/candidates";
import type { InvoiceRefs, LineRef } from "../lib/invoice/schema";
import { ledgerEntries, parseLedgerBook } from "../lib/ledger/lookup";
import { type Extractor, startSession } from "../lib/session/run";
import { type Answer, latestSession, newSession, readSession, type Session, SESSION_STATES, transition } from "../lib/session/store";
import { SAY, toMonitorView, VOICE_CREDIT } from "../lib/session/view";
import type { Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const LEDGER_PATH = join(ROOT, "tests/fixtures/tire-ledger.json");
const ledger = ledgerEntries(parseLedgerBook(JSON.parse(readFileSync(LEDGER_PATH, "utf8"))));
const transcripts = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/tire-transcripts.json"), "utf8"),
) as Transcript[];
const byId = (id: string) => {
  const t = transcripts.find((x) => x.recordingId === id);
  if (!t) throw new Error(`素材に無い: ${id}`);
  return t;
};

const made: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nda-run-"));
  made.push(d);
  return d;
}

const cid = (cs: Candidate[], kind: Candidate["kind"], seg: number, text: string, nth = 0): string => {
  const hit = cs.filter((c) => c.kind === kind && c.seg === seg && c.text === text)[nth];
  if (!hit) throw new Error(`候補が無い: ${kind} #${seg} ${text} ${nth}`);
  return hit.id;
};

const ref = (item: LineRef["item"], qty: string | null, over: Partial<LineRef> = {}): LineRef => ({
  item,
  qty,
  unitPrice: null,
  amount: null,
  status: "done",
  evidence: [],
  correctedFrom: null,
  correctedTo: null,
  ...over,
});

/** tests/invoice-assemble.test.ts の手書きの参照を写したもの。 */
function goodRefs(t: Transcript, cs: Candidate[]): InvoiceRefs {
  if (t.recordingId === "tire-001") {
    return {
      lines: [ref(cid(cs, "item", 0, "脱着"), cid(cs, "qty", 0, "4本")), ref(cid(cs, "item", 1, "バランス"), cid(cs, "qty", 1, "4本"))],
      negations: [],
    };
  }
  return {
    lines: [ref(cid(cs, "item", 0, "脱着"), cid(cs, "qty", 0, "4本")), ref({ seg: 1, text: "ホイールナット" }, cid(cs, "qty", 1, "2個", 1))],
    negations: [],
  };
}

/** 偽の extractor（API を呼ばない）。 */
const fakeExtract: Extractor = async (t, l) => {
  const candidates = enumerateCandidates(t, l);
  return { candidates, ...goodRefs(t, candidates) };
};

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 4, 10, 0, clock++));

// --- 偽サーバー（route の試験用） ---

let server: Server;
let fail = false;
let reply: unknown = null;

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (fail) {
        res.statusCode = 500;
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "偽の失敗" } }));
        return;
      }
      res.end(
        JSON.stringify({
          id: "msg",
          type: "message",
          role: "assistant",
          model: "fake",
          content: [{ type: "text", text: JSON.stringify(reply) }],
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
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${addr.port}`;
  process.env.NDA_LEDGER_PATH = LEDGER_PATH;
  process.env.NDA_SESSION_DIR = await tmp();
});

after(async () => {
  server.close();
  for (const d of made) await rm(d, { recursive: true, force: true });
});

// --- (1)〜(4) startSession ---

test("(1) tire-001: asking で止まり、history は idle→listening→thinking→drafting→asking、total 6600、質問 0 件", async () => {
  const dir = await tmp();
  const t = byId("tire-001");
  const s = await startSession({ dir, transcript: t, ledger, extract: fakeExtract, now, id: "run1" });
  const saved = await readSession(dir, "run1");
  assert.ok(saved);
  assert.deepEqual(saved, s);
  assert.equal(saved.status, "asking");
  assert.deepEqual(
    saved.history.map((h) => h.status),
    ["idle", "listening", "thinking", "drafting", "asking"],
  );
  assert.equal(saved.invoice?.total, 6600);
  assert.deepEqual(saved.questions, []);
  assert.equal(saved.transcript?.recordingId, "tire-001");
  assert.ok(saved.refs);
  assert.equal(saved.error, null);
  assert.equal(toMonitorView(saved).say, "合っていれば「請求書頼む」と言ってください");
  assert.equal(toMonitorView(saved).total, 6600);
});

test("(2) 抽出の最中に保存を読むと thinking で transcript が入っている", async () => {
  const dir = await tmp();
  const t = byId("tire-001");
  let seen: Session | null = null;
  const spy: Extractor = async (tt, l) => {
    seen = await readSession(dir, "run2");
    return fakeExtract(tt, l);
  };
  await startSession({ dir, transcript: t, ledger, extract: spy, now, id: "run2" });
  const s = seen as Session | null;
  assert.ok(s);
  assert.equal(s.status, "thinking");
  assert.deepEqual(s.transcript, t);
  assert.equal(toMonitorView(s).say, "明細に分けています");
});

test("(3) extractor が throw すると throw し直し、保存は idle で error あり、say は失敗の台詞", async () => {
  const dir = await tmp();
  const boom: Extractor = async () => {
    throw new Error("偽の抽出の失敗");
  };
  await assert.rejects(
    startSession({ dir, transcript: byId("tire-001"), ledger, extract: boom, now, id: "run3" }),
    /偽の抽出の失敗/,
  );
  const s = await readSession(dir, "run3");
  assert.ok(s);
  assert.equal(s.status, "idle");
  assert.deepEqual(
    s.history.map((h) => h.status),
    ["idle", "listening", "thinking", "idle"],
  );
  // SDK の文は保存しない。固定の文と例外の種類名だけ
  assert.equal(s.error, "抽出に失敗しました（Error）");
  assert.equal(s.extraction?.inputTokens, null);
  assert.ok(Number.isFinite(s.extraction?.seconds));
  assert.equal(toMonitorView(s).say, "うまく分けられませんでした。もう一度話してください");
});

test("(4) tire-003: ホイールナットの単価が料金表に無い → 質問 1 件以上、say は最初の質問、行は ask・amount null、total null", async () => {
  const dir = await tmp();
  const s = await startSession({ dir, transcript: byId("tire-003"), ledger, extract: fakeExtract, now, id: "run4" });
  assert.equal(s.status, "asking");
  assert.ok(s.questions.length >= 1);
  const v = toMonitorView(s);
  assert.equal(v.say, s.questions[0].text);
  assert.deepEqual(v.questions, s.questions.map((q) => q.text));
  const nut = v.lines.find((l) => l.item.includes("ホイールナット"));
  assert.ok(nut, JSON.stringify(v.lines));
  assert.equal(nut.status, "ask");
  assert.equal(nut.amount, null);
  assert.equal(v.total, null);
  assert.equal(v.confirmationCount, s.invoice?.confirmations.length);
  assert.ok(v.confirmationCount >= 1);
});

// --- (5)〜(6)・(8) toMonitorView ---

test("(5) toMonitorView(null) は idle・行なし・total null・クレジット付き", () => {
  const v = toMonitorView(null);
  assert.equal(v.id, null);
  assert.equal(v.state, "idle");
  assert.equal(v.heard, null);
  assert.equal(v.say, "待っています。手は整備のままで。");
  assert.deepEqual(v.lines, []);
  assert.equal(v.total, null);
  assert.deepEqual(v.questions, []);
  assert.equal(v.confirmationCount, 0);
  assert.equal(v.approved, false);
  assert.equal(v.credit, "VOICEVOX:ずんだもん");
  assert.equal(VOICE_CREDIT, "VOICEVOX:ずんだもん");
});

test("(6) 6 つの状態それぞれの say", async () => {
  const t0 = new Date("2026-11-04T10:00:00.000Z");
  const idle = newSession("v6", t0);
  const listening = transition(idle, "listening", t0);
  const thinking = { ...transition(listening, "thinking", t0), transcript: byId("tire-001") };
  const asking = await startSession({ dir: await tmp(), transcript: byId("tire-001"), ledger, extract: fakeExtract, now, id: "v6" });
  const drafting = { ...asking, status: "drafting" as const };
  const done = transition({ ...asking, approved: true, approvedAt: t0.toISOString() }, "done", t0);
  const says: Record<string, string> = {
    idle: toMonitorView(idle).say,
    listening: toMonitorView(listening).say,
    thinking: toMonitorView(thinking).say,
    drafting: toMonitorView(drafting).say,
    asking: toMonitorView(asking).say,
    done: toMonitorView(done).say,
  };
  assert.deepEqual(Object.keys(says), [...SESSION_STATES]);
  assert.deepEqual(says, {
    idle: "待っています。手は整備のままで。",
    listening: "聞いています",
    thinking: "明細に分けています",
    drafting: "請求書を作っています",
    asking: "合っていれば「請求書頼む」と言ってください",
    done: "2行入れました。発行は人が押してください",
  });
  assert.equal(SAY.done(2), says.done);
  // heard は全発話をそのままつなぐ
  assert.equal(toMonitorView(thinking).heard, byId("tire-001").segments.map((x) => x.text).join(""));
  assert.equal(toMonitorView(listening).heard, null);
  assert.equal(toMonitorView(done).approved, true);
  assert.equal(toMonitorView(done).state, "done");
});

test("答えた行は answered に quote が入り、unread と approve は入らない", async () => {
  const s = await startSession({ dir: await tmp(), transcript: byId("tire-003"), ledger, extract: fakeExtract, now, id: "ans" });
  const p: Answer["provenance"] = { recordingId: "tire-003-a", startSec: 0, endSec: 2, speaker: "father", quote: "1個330円" };
  const answers: Answer[] = [
    { at: "x", questionIndex: 0, lineIndex: 1, provenance: p, source: "answer", action: { kind: "setUnitPrice", value: 330 } },
    { at: "x", questionIndex: 0, lineIndex: 1, provenance: { ...p, quote: "聞こえない" }, source: "answer", action: { kind: "unread", reason: "雑音" } },
    { at: "x", questionIndex: 0, lineIndex: 1, provenance: { ...p, quote: "請求書頼む" }, source: "answer", action: { kind: "approve" } },
  ];
  const v = toMonitorView({ ...s, answers });
  assert.deepEqual(v.lines[1].answered, ["1個330円"]);
  assert.deepEqual(v.lines[0].answered, []);
});

test("(8) toMonitorView は入力を書き換えない", async () => {
  const s = await startSession({ dir: await tmp(), transcript: byId("tire-003"), ledger, extract: fakeExtract, now, id: "v8" });
  const before = structuredClone(s);
  const v = toMonitorView(s);
  assert.deepEqual(s, before);
  v.lines.forEach((l) => {
    l.item = "書き換え";
    l.answered.push("書き換え");
  });
  v.questions.push("書き換え");
  assert.deepEqual(s, before);
  const n = toMonitorView(null);
  n.lines.push(v.lines[0]);
  assert.deepEqual(toMonitorView(null).lines, []);
});

// --- (7) route handler ---

test("(7) route: 不正な body は 400、POST は 201、GET current は同じ id、[id] に ../x は 404、偽サーバーの 500 は 502 でキーを出さない", async () => {
  const post = await import("../app/api/session/route");
  const current = await import("../app/api/session/current/route");
  const one = await import("../app/api/session/[id]/route");
  const req = (body: string) =>
    new Request("http://localhost/api/session", { method: "POST", headers: { "content-type": "application/json" }, body });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  // 何も無いときの current
  const empty = await current.GET(new Request("http://localhost/api/session/current"));
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), toMonitorView(null));

  assert.equal((await post.POST(req("{"))).status, 400);
  assert.equal((await post.POST(req(JSON.stringify({})))).status, 400);
  assert.equal((await post.POST(req(JSON.stringify({ transcript: { recordingId: "x" } })))).status, 400);

  const t = byId("tire-001");
  reply = goodRefs(t, enumerateCandidates(t, ledger));
  fail = false;
  const created = await post.POST(req(JSON.stringify({ transcript: t })));
  assert.equal(created.status, 201);
  const body = (await created.json()) as { id: string; view: ReturnType<typeof toMonitorView> };
  assert.equal(typeof body.id, "string");
  assert.equal(body.view.id, body.id);
  assert.equal(body.view.state, "asking");
  assert.equal(body.view.total, 6600);

  const cur = await current.GET(new Request("http://localhost/api/session/current"));
  assert.equal(cur.status, 200);
  const curView = (await cur.json()) as ReturnType<typeof toMonitorView>;
  assert.equal(curView.id, body.id);
  assert.deepEqual(curView, body.view);

  const got = await one.GET(new Request(`http://localhost/api/session/${body.id}`), ctx(body.id));
  assert.equal(got.status, 200);
  assert.deepEqual(await got.json(), body.view);

  assert.equal((await one.GET(new Request("http://localhost/api/session/x"), ctx("../x"))).status, 404);
  assert.equal((await one.GET(new Request("http://localhost/api/session/none"), ctx("none"))).status, 404);

  fail = true;
  const bad = await post.POST(req(JSON.stringify({ transcript: t })));
  assert.equal(bad.status, 502);
  const text = await bad.text();
  assert.ok(!text.includes("test"), text);
  assert.ok("error" in (JSON.parse(text) as object));
  // 保存された error にも SDK の文（「偽の失敗」）を入れない
  const failed = (await latestSession(process.env.NDA_SESSION_DIR as string)) as Session;
  assert.equal(failed.status, "idle");
  assert.match(failed.error ?? "", /^抽出に失敗しました（[A-Za-z]+）$/);
  assert.ok(!(failed.error ?? "").includes("偽の失敗"));
  // 成功した抽出は偽サーバーの usage（1・1）を保存する
  const okSaved = await readSession(process.env.NDA_SESSION_DIR as string, body.id);
  assert.equal(okSaved?.extraction?.inputTokens, 1);
  assert.equal(okSaved?.extraction?.outputTokens, 1);
  fail = false;
});

test("抽出の費用: usage とかかった秒数を保存し、失敗は例外の種類名だけを残す", async () => {
  const dir = await tmp();
  const withUsage: Extractor = async (t, l) => ({ ...(await fakeExtract(t, l)), usage: { inputTokens: 1200, outputTokens: 340 } });
  const s = await startSession({ dir, transcript: byId("tire-001"), ledger, extract: withUsage, now, id: "cost1" });
  assert.equal(s.extraction?.inputTokens, 1200);
  assert.equal(s.extraction?.outputTokens, 340);
  assert.ok((s.extraction?.seconds ?? -1) >= 0);
  assert.deepEqual(await readSession(dir, "cost1"), s);
  // 偽の extractor が usage を返さなければ null（推測しない）
  const plain = await startSession({ dir, transcript: byId("tire-001"), ledger, extract: fakeExtract, now, id: "cost2" });
  assert.equal(plain.extraction?.inputTokens, null);

  class FakeApiError extends Error {}
  const boom: Extractor = async () => {
    throw new FakeApiError("401 invalid x-api-key 偽のキーの値 要求の中身");
  };
  await assert.rejects(startSession({ dir, transcript: byId("tire-001"), ledger, extract: boom, now, id: "cost3" }));
  const f = await readSession(dir, "cost3");
  assert.equal(f?.error, "抽出に失敗しました（FakeApiError）");
});
