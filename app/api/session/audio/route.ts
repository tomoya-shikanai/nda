/**
 * 音声ファイルを受けて、文字起こし → 明細と質問を作る（W6）。認証は無い（hosted で公開する前に別 Issue で決める）。
 * 音声はファイルに保存しない。応答に API キーや失敗の中身を入れない。処理は lib/session/routes.ts と共用。
 */
import { readAudioForm, startFromAudio } from "../../../../lib/session/routes";

export async function POST(request: Request) {
  const form = await readAudioForm(request);
  if (form instanceof Response) return form;
  return startFromAudio(form);
}
