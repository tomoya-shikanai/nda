/**
 * モニター用: 最新の作業の say をずんだもんの声（WAV）で返す（W5）。
 * VOICEVOX が動いていない・失敗したときは 503 と { error }。画面は文字だけで続く。
 * 毎回動かすための印は ../route.ts の注と同じ。
 */
import { errorKind, logEvent, since } from "../../../../../lib/log/events";
import { latestSession, sessionDir } from "../../../../../lib/session/store";
import { viewOf } from "../../../../../lib/session/routes";
import { synthesize } from "../../../../../lib/voice/tts";

export async function GET(request: Request) {
  request.headers.has("accept"); // 毎回動かすための印（../route.ts の注）
  // 客の label・会話の受け皿の声の文はメモリにある（画面の JSON と同じ文を声にする）
  const view = viewOf(await latestSession(sessionDir()));
  let wav: Uint8Array;
  const t0 = performance.now();
  try {
    wav = await synthesize(view.say);
    logEvent("tts", { ms: since(t0), ok: true, error: null });
  } catch (e) {
    logEvent("tts", { ms: since(t0), ok: false, error: e instanceof Error && e.message.startsWith("VOICEVOX") ? "VoicevoxError" : errorKind(e) });
    const error = e instanceof Error ? e.message : String(e);
    return Response.json({ error }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return new Response(wav as BodyInit, {
    status: 200,
    headers: { "content-type": "audio/wav", "cache-control": "no-store" },
  });
}
