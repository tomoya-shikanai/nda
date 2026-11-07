/**
 * モニター用: 最新の作業の 1 つの JSON（W2）。
 * cacheComponents が有効なので、GET はビルド時に prerender され得る。request.headers に触れると
 * prerender が止まり、毎回リクエストの時に動く（文書 01-getting-started/15-route-handlers の「With Cache Components」）。
 * connection() はリクエストの外（試験から直接呼ぶ）で throw するので使わない。
 * 見回りのついでに、事務所の照合の期限切れと、承認後の依頼の送り直しを行う（docs/design/pi-office.md §4・§5。常駐は作らない）。
 */
import { officeFromEnv, tickOffice } from "../../../../lib/office/link";
import { viewOf } from "../../../../lib/session/routes";
import { latestSession, sessionDir } from "../../../../lib/session/store";

export async function GET(request: Request) {
  request.headers.has("accept"); // 毎回動かすための印（上の注）
  const dir = sessionDir();
  const latest = await latestSession(dir);
  const s = latest === null ? null : await tickOffice(dir, officeFromEnv(), latest);
  return Response.json(viewOf(s), { headers: { "cache-control": "no-store" } });
}
