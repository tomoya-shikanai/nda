/**
 * ずんだもんの声（lib/voice/tts.ts）と speech の route の検証（W5）。
 * 実 VOICEVOX は呼ばない。127.0.0.1 の一時ポートの偽 VOICEVOX で置き換える。data/ は読まない。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { newSession, writeSession } from "../lib/session/store";
import { SAY } from "../lib/session/view";
import { synthesize, voicevoxBaseUrl, ZUNDAMON_NORMAL } from "../lib/voice/tts";

const FAKE_WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45, 0, 255]);
const FAKE_QUERY = { accent_phrases: [{ moras: [] }], speedScale: 1, outputSamplingRate: 24000 };

type Seen = { method: string; path: string; params: URLSearchParams; contentType?: string; body: string };

const servers: Server[] = [];
const made: string[] = [];

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

/** 偽 VOICEVOX。audioQueryStatus を変えると audio_query が失敗する。 */
async function fakeVoicevox(audioQueryStatus = 200) {
  const seen: Seen[] = [];
  const { url, server } = await listen((req, res, body) => {
    const u = new URL(req.url ?? "/", "http://x");
    seen.push({
      method: req.method ?? "",
      path: u.pathname,
      params: u.searchParams,
      contentType: req.headers["content-type"],
      body,
    });
    if (u.pathname === "/audio_query") {
      res.statusCode = audioQueryStatus;
      res.setHeader("content-type", "application/json");
      res.end(audioQueryStatus === 200 ? JSON.stringify(FAKE_QUERY) : JSON.stringify({ detail: "偽の失敗" }));
      return;
    }
    if (u.pathname === "/synthesis") {
      res.setHeader("content-type", "audio/wav");
      res.end(Buffer.from(FAKE_WAV));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return { url, server, seen };
}

after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  for (const d of made) await rm(d, { recursive: true, force: true });
});

test("既定: speaker は ZUNDAMON_NORMAL(3)、VOICEVOX_URL が無ければ 127.0.0.1:50021", () => {
  assert.equal(ZUNDAMON_NORMAL, 3);
  const prev = process.env.VOICEVOX_URL;
  delete process.env.VOICEVOX_URL;
  assert.equal(voicevoxBaseUrl(), "http://127.0.0.1:50021");
  process.env.VOICEVOX_URL = "http://127.0.0.1:1";
  assert.equal(voicevoxBaseUrl(), "http://127.0.0.1:1");
  if (prev === undefined) delete process.env.VOICEVOX_URL;
  else process.env.VOICEVOX_URL = prev;
});

test("(1) audio_query に日本語の text と speaker 3、synthesis に応答 JSON がそのまま届き、WAV のバイト列が返る", async () => {
  const { url, seen } = await fakeVoicevox();
  const text = "タイヤ脱着、4本で合ってるのだ？";
  const wav = await synthesize(text, { baseUrl: url });
  assert.deepEqual(wav, FAKE_WAV);
  assert.equal(seen.length, 2);
  const [q, s] = seen;
  assert.equal(q.method, "POST");
  assert.equal(q.path, "/audio_query");
  assert.equal(q.params.get("text"), text);
  assert.equal(q.params.get("speaker"), "3");
  assert.equal(s.method, "POST");
  assert.equal(s.path, "/synthesis");
  assert.equal(s.params.get("speaker"), "3");
  assert.match(s.contentType ?? "", /^application\/json/);
  assert.equal(s.body, JSON.stringify(FAKE_QUERY));
  assert.deepEqual(JSON.parse(s.body), FAKE_QUERY);
});

test("(2) audio_query が 500 なら状態コードつきで throw し、synthesis を呼ばない", async () => {
  const { url, seen } = await fakeVoicevox(500);
  await assert.rejects(synthesize("聞いています", { baseUrl: url }), /500/);
  assert.deepEqual(
    seen.map((x) => x.path),
    ["/audio_query"],
  );
});

test("(3) 応答の無い偽サーバーで timeoutMs を短くすると throw する", async () => {
  const { url } = await listen(() => {
    /* 応答しない */
  });
  const t0 = Date.now();
  await assert.rejects(synthesize("聞いています", { baseUrl: url, timeoutMs: 100 }));
  assert.ok(Date.now() - t0 < 5000);
});

test("(4) 空文字は throw し、呼ばない", async () => {
  let called = 0;
  const spy = (async () => {
    called++;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  await assert.rejects(synthesize("", { fetch: spy }));
  assert.equal(called, 0);
});

test("(5) route: 200・audio/wav・no-store で WAV を返し、偽サーバーを止めると 503 と { error }", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nda-voice-"));
  made.push(dir);
  process.env.NDA_SESSION_DIR = dir;
  const s = newSession("voice1", new Date(Date.UTC(2026, 10, 4, 10, 0, 0)));
  await writeSession(dir, { ...s, status: "listening" });

  const { url, server, seen } = await fakeVoicevox();
  process.env.VOICEVOX_URL = url;
  const speech = await import("../app/api/session/current/speech/route");

  const ok = await speech.GET(new Request("http://localhost/api/session/current/speech?t=1"));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "audio/wav");
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await ok.arrayBuffer()), FAKE_WAV);
  assert.equal(seen[0]?.params.get("text"), SAY.listening);

  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));

  const down = await speech.GET(new Request("http://localhost/api/session/current/speech?t=2"));
  assert.equal(down.status, 503);
  const body = (await down.json()) as { error?: unknown };
  assert.equal(typeof body.error, "string");
});
