/**
 * 聞き役（device/listener）の今の状態（起動語の後に聞いている・送っている・待っている）。画面の「話してください」の合図に使う。
 * プロセスのメモリにだけ持つ（作業ファイルにもログにも書かない）。route ごとにモジュールが分かれても同じ入れ物を使うよう globalThis に置く。
 * 受け口は POST /api/listener/state（127.0.0.1 からだけ）。聞き役が落ちて idle を送れなかったときに画面が「話してください」のまま
 * 残らないよう、listening は残りの秒を過ぎたら、sending は SENDING_STALE_SEC を過ぎたら idle とみなす。
 */
import { z } from "zod";

export const LISTENER_STATES = ["listening", "sending", "idle"] as const;
export type ListenerState = (typeof LISTENER_STATES)[number];

/** 受け口の body。自由な文字列は入れない。until は残りの秒（listening のとき）。 */
export const ListenerStateBody = z
  .object({
    state: z.enum(LISTENER_STATES),
    until: z.number().positive().max(120).optional(),
  })
  .strict();

/** 送っている（STT と抽出）を、これより長く知らせが無ければ idle とみなす（聞き役の送信の期限 180 秒より長く）。 */
export const SENDING_STALE_SEC = 200;
/** listening の残りの秒を過ぎてからの余裕。 */
const GRACE_SEC = 1;

export type ListenerView = { state: ListenerState; since: string; remainingSec: number | null };

type Held = { state: ListenerState; since: number; until: number | null };
const KEY = Symbol.for("nda.listener.state");

function box(): { v: Held | null } {
  const g = globalThis as unknown as Record<symbol, { v: Held | null } | undefined>;
  g[KEY] ??= { v: null };
  return g[KEY];
}

export function setListenerState(b: z.infer<typeof ListenerStateBody>, now = new Date()): void {
  box().v = { state: b.state, since: now.getTime(), until: b.until ?? null };
}

/** 画面に出す形。知らせが無い・古いなら idle。 */
export function listenerView(now = new Date()): ListenerView {
  const h = box().v;
  const t = now.getTime();
  const idle: ListenerView = { state: "idle", since: new Date(h?.since ?? t).toISOString(), remainingSec: null };
  if (h === null || h.state === "idle") return idle;
  const age = (t - h.since) / 1000;
  if (h.state === "sending") return age > SENDING_STALE_SEC ? idle : { state: "sending", since: new Date(h.since).toISOString(), remainingSec: null };
  if (h.until !== null && age > h.until + GRACE_SEC) return idle;
  const remainingSec = h.until === null ? null : Math.max(0, Math.ceil(h.until - age));
  return { state: "listening", since: new Date(h.since).toISOString(), remainingSec };
}

/** 試験用。 */
export function clearListenerState(): void {
  box().v = null;
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_ADDR = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/i;

/**
 * 127.0.0.1 からの知らせか。route では接続元の番地が見えないので、次の全部で決める（違えば断る）:
 * - Host が 127.0.0.1・localhost・[::1]（工場の本体は 127.0.0.1:3000 だけで待つ。LAN からは関所の別の道しか通らない）
 * - 中継の印（X-Forwarded-For・X-Real-IP）があるなら、そのどれもが 127.x か ::1（hosted の公開の版は中継が外の番地を入れるので断る）
 */
export function fromLoopback(headers: Headers): boolean {
  if (!LOOPBACK_HOST.test(headers.get("host") ?? "")) return false;
  for (const name of ["x-forwarded-for", "x-real-ip"]) {
    const v = headers.get(name);
    if (v === null) continue;
    const addrs = v.split(",").map((x) => x.trim());
    if (addrs.length === 0 || !addrs.every((a) => LOOPBACK_ADDR.test(a))) return false;
  }
  if (headers.has("forwarded")) return false;
  return true;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** POST /api/listener/state の中身。127.0.0.1 からでなければ 403、形が違えば 400。 */
export async function handleListenerState(request: Request, now = new Date()): Promise<Response> {
  if (!fromLoopback(request.headers)) return json({ error: "この機械の中からだけ受けます" }, 403);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "body が JSON でない" }, 400);
  }
  const b = ListenerStateBody.safeParse(raw);
  if (!b.success) return json({ error: "形が違う" }, 400);
  setListenerState(b.data, now);
  return json({ ok: true });
}
