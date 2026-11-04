/**
 * モニター用: 最新の作業の 1 つの JSON（W2）。
 * cacheComponents が有効なので、GET はビルド時に prerender され得る。request.headers に触れると
 * prerender が止まり、毎回リクエストの時に動く（文書 01-getting-started/15-route-handlers の「With Cache Components」）。
 * connection() はリクエストの外（試験から直接呼ぶ）で throw するので使わない。
 */
import { loadCustomers } from "../../../../lib/customer/load";
import { latestSession, sessionDir } from "../../../../lib/session/store";
import { toMonitorView } from "../../../../lib/session/view";

export async function GET(request: Request) {
  request.headers.has("accept"); // 毎回動かすための印（上の注）
  const view = toMonitorView(await latestSession(sessionDir()), await loadCustomers());
  return Response.json(view, { headers: { "cache-control": "no-store" } });
}
