/**
 * 現場の聞き役（device/listener）の入口。multipart: vendor=scribe|gemini, file。
 * 最新の作業が asking（質問中か承認待ち）なら、その返事として当てる。それ以外は新しい作業を作る（lib/session/voice.ts の routeVoice）。
 * 音声はファイルに保存しない。応答に API キーや失敗の中身を入れない。
 */
import { readAudioForm, voiceFromAudio } from "../../../../lib/session/routes";

export async function POST(request: Request) {
  const form = await readAudioForm(request);
  if (form instanceof Response) return form;
  return voiceFromAudio(form);
}
