/**
 * 聞き役（device/listener）が今の状態（listening・sending・idle）を知らせる受け口。127.0.0.1 からだけ受ける（lib/listener/state.ts）。
 * 状態はメモリにだけ持ち、GET /api/session/current の view の listener に出る。
 */
import { handleListenerState } from "../../../../lib/listener/state";

export async function POST(request: Request) {
  return handleListenerState(request);
}
