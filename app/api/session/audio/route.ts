/**
 * 音声ファイルを受けて、文字起こし → 明細と質問を作る（W6）。認証は無い（hosted で公開する前に別 Issue で決める）。
 * 音声はファイルに保存しない（メモリで STT に渡すだけ）。応答に API キーや失敗の中身を入れない。
 * ベンダーは呼ぶ側が選ぶ（2 社の照合・自動の切り替えは #31 で実録音の後に決める）。
 */
import { randomUUID } from "node:crypto";
import { loadLedger } from "../../../../lib/ledger/lookup";
import { startSession } from "../../../../lib/session/run";
import { sessionDir } from "../../../../lib/session/store";
import { toMonitorView } from "../../../../lib/session/view";
import { transcribeGemini } from "../../../../lib/stt/gemini";
import { transcribeScribe } from "../../../../lib/stt/scribe";
import type { Transcript } from "../../../../lib/stt/types";

const KEY_ENV = { scribe: "ELEVENLABS_API_KEY", gemini: "GEMINI_API_KEY" } as const;

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "body が multipart でない" }, { status: 400 });
  }
  const vendor = form.get("vendor");
  if (vendor !== "scribe" && vendor !== "gemini") {
    return Response.json({ error: "vendor は scribe か gemini" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return Response.json({ error: "file が無い" }, { status: 400 });
  }

  const apiKey = process.env[KEY_ENV[vendor]];
  if (!apiKey) return Response.json({ error: "API キーが無い" }, { status: 500 });

  const id = randomUUID();
  const audio = { data: new Uint8Array(await file.arrayBuffer()), mimeType: file.type || "audio/wav", recordingId: id };
  let transcript: Transcript;
  try {
    transcript =
      vendor === "scribe" ? await transcribeScribe(audio, { apiKey }) : await transcribeGemini(audio, { apiKey });
  } catch {
    return Response.json({ error: "文字起こしに失敗しました" }, { status: 502 });
  }

  const ledger = await loadLedger(process.env.NDA_LEDGER_PATH ?? "data/ledger.json");
  try {
    const s = await startSession({ dir: sessionDir(), transcript, ledger, id });
    return Response.json({ id: s.id, view: toMonitorView(s) }, { status: 201 });
  } catch {
    return Response.json({ error: "明細に分けられませんでした" }, { status: 502 });
  }
}
