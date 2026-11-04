/**
 * 相棒の台詞を VOICEVOX（ずんだもん）の声にする（W5）。
 * VOICEVOX エンジンの HTTP API: POST /audio_query → その JSON をそのまま POST /synthesis → WAV。
 * 失敗は状態コードつきで throw する。呼ぶ側（route）は 503 にして、画面は文字だけで続ける。
 */

/**
 * ずんだもん ノーマルの speaker id。
 * 注: 実際の値は朝に人が VOICEVOX の `GET /speakers` で確かめて直す。
 */
export const ZUNDAMON_NORMAL = 3;

const DEFAULT_URL = "http://127.0.0.1:50021";
const DEFAULT_TIMEOUT_MS = 15000;

export function voicevoxBaseUrl(): string {
  return process.env.VOICEVOX_URL || DEFAULT_URL;
}

export type SynthesizeOptions = {
  baseUrl?: string;
  speaker?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export async function synthesize(text: string, opts: SynthesizeOptions = {}): Promise<Uint8Array> {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("読み上げる文字が空");
  }
  const base = (opts.baseUrl ?? voicevoxBaseUrl()).replace(/\/+$/, "");
  const speaker = opts.speaker ?? ZUNDAMON_NORMAL;
  const f = opts.fetch ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const q = await f(`${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, {
    method: "POST",
    signal,
  });
  if (!q.ok) {
    await q.body?.cancel();
    throw new Error(`VOICEVOX audio_query が失敗: HTTP ${q.status}`);
  }
  const query = await q.text();

  const s = await f(`${base}/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: query,
    signal,
  });
  if (!s.ok) {
    await s.body?.cancel();
    throw new Error(`VOICEVOX synthesis が失敗: HTTP ${s.status}`);
  }
  return new Uint8Array(await s.arrayBuffer());
}
