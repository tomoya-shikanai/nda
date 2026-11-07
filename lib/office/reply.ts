/**
 * 事務所→工場の返しの受け口（POST /api/office/reply、docs/design/pi-office.md §2・§3）。
 * Authorization: Bearer <NDA_OFFICE_TOKEN>。合言葉が無い・違えば 401（比べるのは時間一定）。工場に合言葉が無ければ受け口を閉じて 503。
 * 形は ToFactory で確かめる（違えば 400）。作業が無ければ 404（事務所は再送しない）。
 * 同じ id は 2 回目から何もしない（200 と duplicate）。待っていない答えは 200 と { accepted:false, why:"stale" }（事務所は再送しない）。
 * 応答とログに客の情報を入れない（label はメモリにだけ持つ）。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { withSessionLock } from "../session/lock";
import { readSession, sessionDir, writeSession } from "../session/store";
import { applyToFactory } from "./flow";
import { setLabel } from "./labels";
import { ToFactory } from "./schema";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** 合言葉を時間一定で比べる（長さの違いも漏らさないよう、ハッシュにそろえてから比べる）。 */
export function tokenMatches(header: string | null, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  const given = m ? m[1] : "";
  const ok = timingSafeEqual(digest(given), digest(token));
  return ok && m !== null;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function handleOfficeReply(request: Request, now = new Date()): Promise<Response> {
  const token = process.env.NDA_OFFICE_TOKEN;
  if (!token) return json({ error: "受け口は閉じています" }, 503);
  if (!tokenMatches(request.headers.get("authorization"), token)) return json({ error: "合言葉が違う" }, 401);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "body が JSON でない" }, 400);
  }
  const m = ToFactory.safeParse(raw);
  if (!m.success) return json({ error: "形が違う" }, 400);

  const dir = sessionDir();
  const msg = m.data;
  // 作業の排他の中で読み直して当てて書く（ほかの経路の書き込みを消さない）
  return withSessionLock(msg.sessionId, async () => {
    const s = await readSession(dir, msg.sessionId);
    if (s === null) return json({ error: "作業が無い" }, 404);
    const r = applyToFactory(s, msg, now);
    if (!r.accepted) return json({ accepted: false, why: r.why });
    if (r.duplicate) return json({ accepted: true, duplicate: true });
    await writeSession(dir, r.session);
    if (msg.kind === "customer.answer" && msg.result.status === "found") setLabel(s.id, r.label);
    return json({ accepted: true });
  });
}
