/**
 * 相棒の台詞を VOICEVOX（ずんだもん）の声にする（W5）。
 * VOICEVOX エンジンの HTTP API: POST /audio_query → その JSON の speedScale だけを話速に変えて POST /synthesis → WAV。
 * 失敗は状態コードつきで throw する。呼ぶ側（route）は 503 にして、画面は文字だけで続ける。
 */

/**
 * ずんだもん ノーマルの speaker id。
 * 注: 実際の値は朝に人が VOICEVOX の `GET /speakers` で確かめて直す。
 */
export const ZUNDAMON_NORMAL = 3;

const DEFAULT_URL = "http://127.0.0.1:50021";

/** 話速の既定（1.0 が VOICEVOX の標準）。現場で待たせないよう速める。NDA_TTS_SPEED で上書きできる。 */
export const DEFAULT_TTS_SPEED = 1.25;
/** VOICEVOX の speedScale が受ける範囲。 */
const SPEED_MIN = 0.5;
const SPEED_MAX = 2;

/** 話速。NDA_TTS_SPEED が無ければ既定。数でない・範囲の外なら throw（黙って既定に戻さない）。 */
export function ttsSpeed(): number {
  const raw = process.env.NDA_TTS_SPEED;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TTS_SPEED;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < SPEED_MIN || v > SPEED_MAX) {
    throw new Error(`NDA_TTS_SPEED は ${SPEED_MIN}〜${SPEED_MAX} の数: ${JSON.stringify(raw)}`);
  }
  return v;
}
const DEFAULT_TIMEOUT_MS = 15000;

export function voicevoxBaseUrl(): string {
  return process.env.VOICEVOX_URL || DEFAULT_URL;
}

export type SynthesizeOptions = {
  baseUrl?: string;
  speaker?: number;
  /** 話速（speedScale）。無ければ ttsSpeed()。 */
  speed?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export async function synthesize(text: string, opts: SynthesizeOptions = {}): Promise<Uint8Array> {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("読み上げる文字が空");
  }
  const base = (opts.baseUrl ?? voicevoxBaseUrl()).replace(/\/+$/, "");
  const speaker = opts.speaker ?? ZUNDAMON_NORMAL;
  const speed = opts.speed ?? ttsSpeed();
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
  const query = (await q.json()) as Record<string, unknown>;
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    throw new Error("VOICEVOX audio_query の応答が JSON のオブジェクトでない");
  }

  const s = await f(`${base}/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...query, speedScale: speed }),
    signal,
  });
  if (!s.ok) {
    await s.body?.cancel();
    throw new Error(`VOICEVOX synthesis が失敗: HTTP ${s.status}`);
  }
  return new Uint8Array(await s.arrayBuffer());
}
