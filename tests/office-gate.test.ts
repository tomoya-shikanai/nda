/**
 * 事務所の返しの関所（scripts/office-gate.ts）: POST /api/office/reply だけを中継し、それ以外は 404、POST 以外は 405、
 * 本文が上限を超えたら 413。渡すヘッダーは Authorization と Content-Type だけ。本体は偽物（一時の http サーバー）。
 */
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createGate, MAX_BODY, REPLY_PATH } from "../scripts/office-gate";

type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };
let seen: Seen[] = [];
let upstream: Server;
let gate: Server;
let base: string;

const listen = (s: Server) =>
  new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

before(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(202, { "content-type": "application/json", "x-secret-internal": "1" });
      res.end('{"ok":true}');
    });
  });
  const up = await listen(upstream);
  gate = createGate({ upstream: `http://127.0.0.1:${up}` });
  base = `http://127.0.0.1:${await listen(gate)}`;
});

after(() => {
  gate.close();
  upstream.close();
});

test("POST /api/office/reply は本体の同じ道へ中継し、Authorization と Content-Type だけを渡す", async () => {
  seen = [];
  const r = await fetch(`${base}${REPLY_PATH}?x=1`, {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json", cookie: "a=b", "x-forwarded-for": "1.2.3.4" },
    body: '{"v":1}',
  });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(r.headers.get("x-secret-internal"), null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, REPLY_PATH);
  assert.equal(seen[0].body, '{"v":1}');
  assert.equal(seen[0].headers.authorization, "Bearer test-token");
  assert.equal(seen[0].headers["content-type"], "application/json");
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers["x-forwarded-for"], undefined);
});

test("reply 以外の道は 404 で、本体へ届かない", async () => {
  seen = [];
  for (const p of ["/", "/monitor", "/api/session/voice", "/api/ledger", "/api/office/reply/", "/api/office/replyx", "/api/office/../session/current"]) {
    const r = await fetch(`${base}${p}`, { method: "POST", body: "{}" });
    assert.equal(r.status, 404, p);
    await r.body?.cancel();
  }
  const g = await fetch(`${base}/monitor`);
  assert.equal(g.status, 404);
  await g.body?.cancel();
  assert.equal(seen.length, 0);
});

test("reply の道でも POST 以外は 405", async () => {
  seen = [];
  for (const m of ["GET", "PUT", "DELETE", "PATCH"]) {
    const r = await fetch(`${base}${REPLY_PATH}`, { method: m, body: m === "GET" ? undefined : "{}" });
    assert.equal(r.status, 405, m);
    assert.equal(r.headers.get("allow"), "POST");
    await r.body?.cancel();
  }
  assert.equal(seen.length, 0);
});

test("本文が上限を超えたら 413 で、本体へ届かない。上限ちょうどは通す", async () => {
  seen = [];
  const big = await fetch(`${base}${REPLY_PATH}`, { method: "POST", body: "x".repeat(MAX_BODY + 1) });
  assert.equal(big.status, 413);
  await big.body?.cancel();
  assert.equal(seen.length, 0);
  const ok = await fetch(`${base}${REPLY_PATH}`, { method: "POST", body: "x".repeat(MAX_BODY) });
  assert.equal(ok.status, 202);
  await ok.body?.cancel();
  assert.equal(seen.length, 1);
});

test("本体が止まっていれば 502", async () => {
  const dead = createServer();
  const port = await listen(dead);
  await new Promise<void>((r) => dead.close(() => r()));
  const g = createGate({ upstream: `http://127.0.0.1:${port}` });
  const gb = `http://127.0.0.1:${await listen(g)}`;
  const r = await fetch(`${gb}${REPLY_PATH}`, { method: "POST", body: "{}" });
  assert.equal(r.status, 502);
  await r.body?.cancel();
  g.close();
});
