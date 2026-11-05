/**
 * 作業 1 件の 1 つの JSON（W2）。無い ID・形の不正な ID は 404。
 * 毎回動かす書き方は ../current/route.ts の注と同じ。
 */
import { viewOf } from "../../../../lib/session/routes";
import { readSession, sessionDir } from "../../../../lib/session/store";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(request: Request, ctx: RouteContext<"/api/session/[id]">) {
  request.headers.has("accept"); // 毎回動かすための印
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return Response.json({ error: "見つからない" }, { status: 404 });
  const s = await readSession(sessionDir(), id);
  if (s === null) return Response.json({ error: "見つからない" }, { status: 404 });
  return Response.json(viewOf(s), { headers: { "cache-control": "no-store" } });
}
