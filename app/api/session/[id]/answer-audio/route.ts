/**
 * 父の声の返事（音声ファイル）を文字起こしして、作業に当てる。multipart: vendor=scribe|gemini, file。
 * 無い ID 404、形の不正 400、asking でなければ 409、STT のキーが無い 500、STT の失敗 502。承認の言葉もここを通る。
 * 音声はファイルに保存しない。応答に API キーや失敗の中身を入れない。処理は lib/session/routes.ts と共用。
 */
import { answerFromAudio, readAudioForm } from "../../../../../lib/session/routes";

export async function POST(request: Request, ctx: RouteContext<"/api/session/[id]/answer-audio">) {
  const { id } = await ctx.params;
  const form = await readAudioForm(request);
  if (form instanceof Response) return form;
  return answerFromAudio(id, form);
}
