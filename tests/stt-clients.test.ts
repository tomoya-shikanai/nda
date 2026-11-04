/**
 * STT の呼び出し（lib/stt/scribe.ts・gemini.ts・wav.ts）と、音声を受ける route（app/api/session/audio）の検証（W6）。
 * 実 API は呼ばない（fetch を注入する。route は globalThis.fetch を試験の中だけ差し替える）。
 * 音声は試験の中で作る架空の WAV（無音、16kHz モノラル 16bit、2 秒）。data/ は読まない。Claude は偽サーバー。
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { readSession } from "../lib/session/store";
import { transcribeGemini } from "../lib/stt/gemini";
import { transcribeScribe } from "../lib/stt/scribe";
import { TranscriptSchema } from "../lib/stt/types";
import { wavDurationSec } from "../lib/stt/wav";

const ROOT = resolve(import.meta.dirname, "..");

/** 無音の WAV（PCM 16bit）。 */
function silentWav(sec: number, rate = 16000, channels = 1): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = sec * rate * channels * bytesPerSample;
  const buf = new Uint8Array(44 + dataSize);
  const v = new DataView(buf.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (buf[at + i] = c.charCodeAt(0)));
  put(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * channels * bytesPerSample, true);
  v.setUint16(32, channels * bytesPerSample, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, dataSize, true);
  return buf;
}

const WAV = silentWav(2);
const audio = { data: WAV, mimeType: "audio/wav", recordingId: "rec-test" };
const KEY = "sk-fake-key-値-12345";

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (c: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(input instanceof Request ? input.url : input), init: init ?? {} };
    calls.push(c);
    return respond(c);
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** 2 話者・「。」の区切り・spacing・audio_event を含む架空の words。 */
const WORDS = [
  { text: "タイヤ", start: 0.1, end: 0.5, type: "word", speaker_id: "speaker_0" },
  { text: " ", start: 0.5, end: 0.6, type: "spacing", speaker_id: "speaker_0" },
  { text: "四本", start: 0.6, end: 1.0, type: "word", speaker_id: "speaker_0" },
  { text: "替えた。", start: 1.0, end: 1.4, type: "word", speaker_id: "speaker_0" },
  { text: " ", start: 1.4, end: 1.5, type: "spacing", speaker_id: "speaker_0" },
  { text: "(咳)", start: 1.5, end: 1.6, type: "audio_event", speaker_id: "speaker_0" },
  { text: "バランスも", start: 1.6, end: 2.0, type: "word", speaker_id: "speaker_0" },
  { text: "とった", start: 2.0, end: 2.3, type: "word", speaker_id: "speaker_0" },
  { text: " ", start: 2.3, end: 2.4, type: "spacing", speaker_id: "speaker_1" },
  { text: "はい", start: 2.4, end: 2.6, type: "word", speaker_id: "speaker_1" },
  { text: "わかりました！", start: 2.6, end: 3.0, type: "word", speaker_id: "speaker_1" },
  { text: "どうも", start: 3.1, end: 3.4, type: "word" },
];

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

test("(1) Scribe: 要求の URL・ヘッダ・multipart の欄と、words からの発話の分け方・時刻・話者", async () => {
  const { fetch, calls } = fakeFetch(() => json({ text: "全文", words: WORDS }));
  const t = await transcribeScribe(audio, { apiKey: KEY, fetch });

  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(c.init.method, "POST");
  assert.equal((c.init.headers as Record<string, string>)["xi-api-key"], KEY);
  const form = c.init.body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("model_id"), "scribe_v2");
  assert.equal(form.get("language_code"), "jpn");
  assert.equal(form.get("tag_audio_events"), "false");
  assert.equal(form.get("diarize"), "true");
  assert.equal(form.get("timestamps_granularity"), "word");
  assert.equal(form.has("keyterms"), false);
  const file = form.get("file");
  assert.ok(file instanceof Blob);
  assert.equal(file.size, WAV.byteLength);

  assert.equal(t.recordingId, "rec-test");
  assert.equal(t.vendor, "scribe_v2");
  assert.equal(t.language, "ja");
  assert.equal(t.glossaryHint, false);
  assert.deepEqual(t.segments, [
    { startSec: 0.1, endSec: 1.4, speaker: "speaker_0", text: "タイヤ 四本替えた。" },
    { startSec: 1.6, endSec: 2.3, speaker: "speaker_0", text: "バランスもとった" },
    { startSec: 2.4, endSec: 3.0, speaker: "speaker_1", text: "はいわかりました！" },
    { startSec: 3.1, endSec: 3.4, speaker: null, text: "どうも" },
  ]);
});

test("(1') Scribe: keyterms を与えたときだけ語ごとに繰り返し、glossaryHint が true", async () => {
  const { fetch, calls } = fakeFetch(() => json({ words: WORDS }));
  const t = await transcribeScribe(audio, { apiKey: KEY, fetch, keyterms: ["脱着", "バランス"] });
  assert.deepEqual((calls[0].init.body as FormData).getAll("keyterms"), ["脱着", "バランス"]);
  assert.equal(t.glossaryHint, true);
});

test("(2) Scribe: words が空・無いなら text があっても throw", async () => {
  for (const body of [{ text: "全文", words: [] }, { text: "全文" }]) {
    const { fetch } = fakeFetch(() => json(body));
    await assert.rejects(transcribeScribe(audio, { apiKey: KEY, fetch }), /words/);
  }
});

test("(2') Scribe: 語に type・text・start・end が欠ければ throw（黙って捨てない）。時刻の逆転も throw", async () => {
  const w = { text: "脱着4本。", start: 0, end: 1, type: "word", speaker_id: "s0" };
  const bad = [
    [{ ...w, start: undefined }],
    [{ ...w, end: undefined }],
    [{ ...w, type: undefined }],
    [{ ...w, text: undefined }],
    [w, { text: "はしない。", start: 1, end: 2 }],
    [{ ...w, start: "0" }],
  ];
  for (const words of bad) {
    const { fetch } = fakeFetch(() => json({ words }));
    await assert.rejects(transcribeScribe(audio, { apiKey: KEY, fetch }), /type・text・start・end/, JSON.stringify(words));
  }
  // 発話の中で開始が終了より後、発話の順で時刻が逆転
  for (const words of [
    [{ ...w, text: "脱着", start: 5, end: 6 }, { ...w, text: "4本。", start: 1, end: 2 }],
    [{ ...w, start: 5, end: 6 }, { ...w, text: "バランス4本。", start: 1, end: 2 }],
  ]) {
    const { fetch } = fakeFetch(() => json({ words }));
    await assert.rejects(transcribeScribe(audio, { apiKey: KEY, fetch }), JSON.stringify(words));
  }
});

test("(2'') Scribe: 語の開始が終了より後、語の順で開始が逆転したら throw", async () => {
  const w = { text: "脱着", start: 0, end: 1, type: "word", speaker_id: "s0" };
  for (const words of [
    [{ ...w, start: 2, end: 1 }],
    [{ ...w, start: 3, end: 4 }, { ...w, text: "4本。", start: 1, end: 2 }],
    [{ ...w, start: 3, end: 4 }, { text: " ", start: 1, end: 1.5, type: "spacing" }, { ...w, text: "4本。", start: 4, end: 5 }],
  ]) {
    const { fetch } = fakeFetch(() => json({ words }));
    await assert.rejects(transcribeScribe(audio, { apiKey: KEY, fetch }), /開始が終了より後|逆転/, JSON.stringify(words));
  }
});

test("(3'') Gemini: model_output に content が無ければ throw", async () => {
  for (const steps of [[{ type: "model_output" }], [{ type: "model_output", content: [{ type: "text", text: "脱着4本" }] }, { type: "model_output" }]]) {
    const { fetch } = fakeFetch(() => json({ steps }));
    await assert.rejects(transcribeGemini(audio, { apiKey: KEY, fetch }), /content の無い/, JSON.stringify(steps));
  }
});

test("(3') Gemini: model_output の content に text の無いブロックがあれば throw", async () => {
  for (const content of [[{ type: "text", text: "脱着4本" }, { type: "text" }], [{ type: "audio" }]]) {
    const { fetch } = fakeFetch(() => json({ steps: [{ type: "model_output", content }] }));
    await assert.rejects(transcribeGemini(audio, { apiKey: KEY, fetch }), /text の無いブロック/, JSON.stringify(content));
  }
});

test("TranscriptSchema: 時刻が有限で開始 ≤ 終了、発話の順で逆転しない、発話が空でない", () => {
  const seg = (startSec: number, endSec: number, text = "脱着4本。") => ({ startSec, endSec, speaker: null, text });
  const tr = (segments: unknown[]) => ({ recordingId: "r", vendor: "v", language: "ja", glossaryHint: false, segments });
  assert.doesNotThrow(() => TranscriptSchema.parse(tr([seg(0, 1), seg(0.5, 2), seg(2, 2)])));
  for (const segs of [
    [seg(Infinity, 1)],
    [seg(0, Number.NaN)],
    [seg(2, 1)],
    [seg(3, 4), seg(1, 2)],
    [seg(0, 1, "  ")],
    [seg(0, 1, "")],
  ]) {
    assert.throws(() => TranscriptSchema.parse(tr(segs)), JSON.stringify(segs));
  }
});

test("(3) Gemini: 要求の body と、応答の text が 1 発話（endSec 2、speaker null）", async () => {
  const { fetch, calls } = fakeFetch(() =>
    json({
      steps: [
        { type: "user_input", content: [{ type: "text", text: "無視" }] },
        { type: "model_output", content: [{ type: "text", text: "タイヤ4本" }, { type: "text", text: "替えた" }] },
      ],
    }),
  );
  const t = await transcribeGemini(audio, { apiKey: KEY, fetch });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal((c.init.headers as Record<string, string>)["x-goog-api-key"], KEY);
  const body = JSON.parse(String(c.init.body)) as {
    model: string;
    input: { type: string; mime_type: string; data: string }[];
    generation_config: { transcription_config: Record<string, unknown> };
  };
  assert.equal(body.model, "models/gemini-3.5-transcribe");
  assert.equal(body.input[0].type, "audio");
  assert.equal(body.input[0].mime_type, "audio/wav");
  assert.equal(Buffer.from(body.input[0].data, "base64").byteLength, WAV.byteLength);
  assert.deepEqual(body.generation_config.transcription_config.language_codes, ["ja-JP"]);
  assert.equal("custom_vocabulary" in body.generation_config.transcription_config, false);

  assert.equal(t.vendor, "gemini-3.5-transcribe");
  assert.equal(t.recordingId, "rec-test");
  assert.equal(t.glossaryHint, false);
  assert.deepEqual(t.segments, [{ startSec: 0, endSec: 2, speaker: null, text: "タイヤ4本替えた" }]);
});

test("(4) wavDurationSec は 2、WAV でないバイト列で throw", () => {
  assert.equal(wavDurationSec(WAV), 2);
  assert.throws(() => wavDurationSec(new TextEncoder().encode("これは WAV ではない文字列です。")));
  assert.throws(() => wavDurationSec(new Uint8Array(0)));
  assert.throws(() => wavDurationSec(WAV.slice(0, 100))); // data が途中で切れている
});

test("(4') Gemini: WAV でなければ API を呼ばずに throw", async () => {
  const { fetch, calls } = fakeFetch(() => json({ steps: [] }));
  await assert.rejects(transcribeGemini({ ...audio, data: new Uint8Array([1, 2, 3]) }, { apiKey: KEY, fetch }));
  assert.equal(calls.length, 0);
});

test("(5) 2xx でない応答で throw し、エラーにキーの値が含まれない", async () => {
  const echo = () => new Response(`invalid key ${KEY}`, { status: 401 });
  for (const run of [
    () => transcribeScribe(audio, { apiKey: KEY, fetch: fakeFetch(echo).fetch }),
    () => transcribeGemini(audio, { apiKey: KEY, fetch: fakeFetch(echo).fetch }),
  ]) {
    await assert.rejects(run(), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /401/);
      assert.ok(!e.message.includes(KEY), e.message);
      return true;
    });
  }
});

// --- (6) route ---

const made: string[] = [];
let server: Server;

before(async () => {
  server = createServer((req, res) => {
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
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${addr.port}`;
  process.env.NDA_LEDGER_PATH = join(ROOT, "tests/fixtures/tire-ledger.json");
  const d = await mkdtemp(join(tmpdir(), "nda-audio-"));
  made.push(d);
  process.env.NDA_SESSION_DIR = d;
});

after(async () => {
  server.close();
  for (const d of made) await rm(d, { recursive: true, force: true });
});

test("(6) route: キーが無いと 500 で STT を呼ばない、vendor が無いと 400、正常で 201 と recordingId がセッションの id、音声のファイルができない", async () => {
  const route = await import("../app/api/session/audio/route");
  const req = (fields: Record<string, string | Blob>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return new Request("http://localhost/api/session/audio", { method: "POST", body: form });
  };
  const file = () => new File([WAV as Uint8Array<ArrayBuffer>], "a.wav", { type: "audio/wav" });

  const original = globalThis.fetch;
  const sttCalls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.elevenlabs.io/")) {
      sttCalls.push(url);
      return json({ words: WORDS });
    }
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      sttCalls.push(url);
      return json({ steps: [{ type: "model_output", content: [{ type: "text", text: "タイヤ4本替えた" }] }] });
    }
    return original(input, init); // Claude の偽サーバーへはそのまま
  }) as typeof fetch;
  const savedKeys = { e: process.env.ELEVENLABS_API_KEY, g: process.env.GEMINI_API_KEY };
  const tmpBefore = new Set(await readdir(tmpdir()));
  try {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.GEMINI_API_KEY;

    // vendor が無い・違う
    assert.equal((await route.POST(req({ file: file() }))).status, 400);
    assert.equal((await route.POST(req({ file: file(), vendor: "whisper" }))).status, 400);

    // キーが無い
    for (const vendor of ["scribe", "gemini"]) {
      const r = await route.POST(req({ file: file(), vendor }));
      assert.equal(r.status, 500);
      assert.match(await r.text(), /API キーが無い/);
    }
    assert.equal(sttCalls.length, 0);

    process.env.ELEVENLABS_API_KEY = KEY;
    process.env.GEMINI_API_KEY = KEY;
    const dir = process.env.NDA_SESSION_DIR ?? "";
    const ids: string[] = [];
    for (const vendor of ["scribe", "gemini"]) {
      const r = await route.POST(req({ file: file(), vendor }));
      const text = await r.text();
      assert.equal(r.status, 201, text);
      assert.ok(!text.includes(KEY));
      const body = JSON.parse(text) as { id: string; view: { id: string } };
      assert.equal(body.view.id, body.id);
      const s = await readSession(dir, body.id);
      assert.ok(s?.transcript);
      assert.equal(s.transcript.recordingId, body.id);
      ids.push(body.id);
    }
    assert.equal(sttCalls.length, 2);
    assert.notEqual(ids[0], ids[1]);

    // STT の失敗は 502、キーを返さない
    globalThis.fetch = (async () => new Response(`bad ${KEY}`, { status: 500 })) as typeof fetch;
    const bad = await route.POST(req({ file: file(), vendor: "scribe" }));
    assert.equal(bad.status, 502);
    assert.ok(!(await bad.text()).includes(KEY));

    // 音声のファイルができない: セッションのフォルダは <id>.json だけ、一時フォルダに音声の拡張子のファイルが増えない
    assert.deepEqual((await readdir(dir)).sort(), ids.map((id) => `${id}.json`).sort());
    const added = (await readdir(tmpdir())).filter((n) => !tmpBefore.has(n));
    assert.deepEqual(added.filter((n) => /\.(wav|webm|mp3|m4a|ogg|flac|aiff?)$/i.test(n)), []);
  } finally {
    globalThis.fetch = original;
    if (savedKeys.e === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedKeys.e;
    if (savedKeys.g === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKeys.g;
  }
});
