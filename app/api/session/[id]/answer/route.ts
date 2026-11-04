/**
 * 父の答えの 1 発話を作業に当てる（W4）。無い ID 404、形の不正 400、asking でなければ 409。
 * 答えの読み取りに Claude を使わない。料金表は POST /api/session と同じ。
 */
import { z } from "zod";
import { loadLedger } from "../../../../../lib/ledger/lookup";
import { answerSession } from "../../../../../lib/session/answer";
import { readSession, sessionDir, writeSession } from "../../../../../lib/session/store";
import { toMonitorView } from "../../../../../lib/session/view";
import { SegmentSchema } from "../../../../../lib/stt/types";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const Body = z.object({ utterance: SegmentSchema });

export async function POST(request: Request, ctx: RouteContext<"/api/session/[id]/answer">) {
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return Response.json({ error: "見つからない" }, { status: 404 });
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "body が JSON でない" }, { status: 400 });
  }
  const body = Body.safeParse(raw);
  if (!body.success) return Response.json({ error: "body の形が違う（{ utterance }）" }, { status: 400 });

  const dir = sessionDir();
  const s = await readSession(dir, id);
  if (s === null) return Response.json({ error: "見つからない" }, { status: 404 });
  if (s.status !== "asking") return Response.json({ error: "答えを受けられる状態でない" }, { status: 409 });

  const ledger = await loadLedger(process.env.NDA_LEDGER_PATH ?? "data/ledger.json");
  const next = answerSession(s, body.data.utterance, ledger, new Date());
  await writeSession(dir, next);
  return Response.json({ view: toMonitorView(next) }, { headers: { "cache-control": "no-store" } });
}
