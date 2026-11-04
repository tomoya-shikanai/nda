/**
 * 文字起こしを受けて、明細と質問を作る（W2）。認証は無い（hosted で公開する前に別 Issue で決める）。
 * 応答に API キーや環境変数の値、抽出の失敗の中身を入れない。
 */
import { z } from "zod";
import { loadLedger } from "../../../lib/ledger/lookup";
import { startSession, TranscriptSchema } from "../../../lib/session/run";
import { sessionDir } from "../../../lib/session/store";
import { toMonitorView } from "../../../lib/session/view";

const Body = z.object({ transcript: TranscriptSchema });

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "body が JSON でない" }, { status: 400 });
  }
  const body = Body.safeParse(raw);
  if (!body.success) return Response.json({ error: "body の形が違う（{ transcript }）" }, { status: 400 });

  const ledger = await loadLedger(process.env.NDA_LEDGER_PATH ?? "data/ledger.json");
  try {
    const s = await startSession({ dir: sessionDir(), transcript: body.data.transcript, ledger });
    return Response.json({ id: s.id, view: toMonitorView(s) }, { status: 201 });
  } catch {
    return Response.json({ error: "明細に分けられませんでした" }, { status: 502 });
  }
}
