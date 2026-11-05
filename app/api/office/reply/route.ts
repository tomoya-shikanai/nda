/**
 * 事務所→工場の返し（照合の答え・入力の結果）。処理は lib/office/reply.ts。
 */
import { handleOfficeReply } from "../../../../lib/office/reply";

export async function POST(request: Request) {
  return handleOfficeReply(request);
}
