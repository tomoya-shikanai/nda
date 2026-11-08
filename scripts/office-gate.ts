/**
 * 事務所の返しの関所。工場の本体（next start）は 127.0.0.1:3000 だけで待ち、LAN には出さない。
 * LAN からは、この関所（既定 0.0.0.0:3001）の POST /api/office/reply だけが本体の同じ道へ中継される。
 * それ以外の道は 404、同じ道の POST 以外は 405、本文が 64KB を超えたら 413。
 * 渡すヘッダーは Authorization と Content-Type だけ（合言葉の確かめは本体の route がする）。
 * Node の標準の http だけを使う（依存なし）。Pi では `node scripts/office-gate.ts`（Node 24 の型の取り除き）で動かす。
 *
 * 環境変数: NDA_GATE_HOST（既定 0.0.0.0）、NDA_GATE_PORT（既定 3001）、NDA_GATE_UPSTREAM（既定 http://127.0.0.1:3000）
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export const REPLY_PATH = "/api/office/reply";
export const MAX_BODY = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 15000;

export type GateOptions = { upstream: string; maxBody?: number; timeoutMs?: number };

function send(res: ServerResponse, status: number, extra: Record<string, string> = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify({ error: status });
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...extra });
  res.end(body);
}

/** 本文を上限まで読む。超えたら null。 */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

export function createGate(opts: GateOptions): Server {
  const max = opts.maxBody ?? MAX_BODY;
  const upstream = new URL(REPLY_PATH, opts.upstream);
  const timeoutMs = opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS;

  const server = createServer(async (req, res) => {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://gate").pathname;
    } catch {
      return send(res, 404);
    }
    if (path !== REPLY_PATH) return send(res, 404, { connection: "close" });
    if (req.method !== "POST") return send(res, 405, { allow: "POST", connection: "close" });
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > max) return send(res, 413, { connection: "close" });

    let body: Buffer | null;
    try {
      body = await readBody(req, max);
    } catch {
      return send(res, 400, { connection: "close" });
    }
    if (body === null) return send(res, 413, { connection: "close" });

    const headers: Record<string, string> = { "content-length": String(body.length) };
    const auth = req.headers.authorization;
    const ctype = req.headers["content-type"];
    if (typeof auth === "string") headers.authorization = auth;
    if (typeof ctype === "string") headers["content-type"] = ctype;

    const up = httpRequest(upstream, { method: "POST", headers, timeout: timeoutMs }, (ur) => {
      const out: Record<string, string> = {};
      const uct = ur.headers["content-type"];
      if (typeof uct === "string") out["content-type"] = uct;
      res.writeHead(ur.statusCode ?? 502, out);
      ur.pipe(res);
    });
    up.on("timeout", () => up.destroy(new Error("timeout")));
    up.on("error", () => send(res, 502));
    up.end(body);
  });
  // 遅いクライアントで口を塞がれないように
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  return server;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const host = process.env.NDA_GATE_HOST || "0.0.0.0";
  const port = Number(process.env.NDA_GATE_PORT || "3001");
  const upstream = process.env.NDA_GATE_UPSTREAM || "http://127.0.0.1:3000";
  createGate({ upstream }).listen(port, host, () => {
    console.log(`office-gate: ${host}:${port} ${REPLY_PATH} → ${upstream}`);
  });
}
