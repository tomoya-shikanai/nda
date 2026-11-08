/**
 * 聞き役の状態（POST /api/listener/state → GET /api/session/current の view.listener）。127.0.0.1 からだけ、形は 3 種と残りの秒だけ、
 * 古い知らせは idle、メモリにだけ持つ。.env は読まない。見るのは自分で作った一時フォルダだけ。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { clearListenerState, fromLoopback, handleListenerState, listenerView, SENDING_STALE_SEC } from "../lib/listener/state";

const post = (body: unknown, headers: Record<string, string> = { host: "127.0.0.1:3000" }, now?: Date) =>
  handleListenerState(
    new Request("http://127.0.0.1:3000/api/listener/state", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    now,
  );

beforeEach(() => clearListenerState());

const made: string[] = [];
const saved = process.env.NDA_SESSION_DIR;
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  if (saved === undefined) delete process.env.NDA_SESSION_DIR;
  else process.env.NDA_SESSION_DIR = saved;
});

test("受け口: 127.0.0.1 からだけ。Host が外・中継の印が外の番地なら 403", async () => {
  assert.equal((await post({ state: "listening", until: 8 })).status, 200);
  assert.equal((await post({ state: "idle" }, { host: "localhost:3000" })).status, 200);
  assert.equal((await post({ state: "idle" }, { host: "nda.example.com" })).status, 403);
  assert.equal((await post({ state: "idle" }, { host: "192.168.1.20:3000" })).status, 403);
  assert.equal((await post({ state: "idle" }, { host: "127.0.0.1:3000", "x-forwarded-for": "203.0.113.5" })).status, 403);
  assert.equal((await post({ state: "idle" }, { host: "127.0.0.1:3000", "x-forwarded-for": "127.0.0.1, 203.0.113.5" })).status, 403);
  assert.equal((await post({ state: "idle" }, { host: "127.0.0.1:3000", "x-forwarded-for": "::ffff:127.0.0.1" })).status, 200);
  assert.equal(fromLoopback(new Headers({ host: "127.0.0.1", forwarded: "for=203.0.113.5" })), false);
});

test("形: 3 種と残りの秒だけ。自由な文字列・ほかの欄・範囲外の秒は 400", async () => {
  for (const bad of [
    { state: "speaking" },
    { state: "listening", until: 0 },
    { state: "listening", until: 121 },
    { state: "listening", until: "8" },
    { state: "idle", note: "x" },
    {},
    "not json",
  ]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(listenerView().state, "idle", "断った知らせは当てない");
});

test("view: listening は残りの秒を数え、過ぎたら idle。sending は長く知らせが無ければ idle", async () => {
  const t0 = new Date("2026-11-08T10:00:00Z");
  await post({ state: "listening", until: 8 }, undefined, t0);
  const at = (sec: number) => listenerView(new Date(t0.getTime() + sec * 1000));
  assert.deepEqual(at(0), { state: "listening", since: t0.toISOString(), remainingSec: 8 });
  assert.equal(at(2.5).remainingSec, 6);
  assert.equal(at(8.5).state, "listening", "少しの余裕");
  assert.equal(at(10).state, "idle", "聞き役が idle を送れなくても画面に残らない");

  await post({ state: "sending" }, undefined, t0);
  assert.deepEqual(at(30), { state: "sending", since: t0.toISOString(), remainingSec: null });
  assert.equal(at(SENDING_STALE_SEC + 1).state, "idle");
  await post({ state: "idle" }, undefined, t0);
  assert.equal(at(0).state, "idle");
});

test("GET /api/session/current の view に listener が出る", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nda-listener-"));
  made.push(dir);
  process.env.NDA_SESSION_DIR = dir;
  const route = await import("../app/api/session/current/route");
  const get = async () => (await route.GET(new Request("http://127.0.0.1:3000/api/session/current"))).json();
  assert.equal((await get()).listener.state, "idle");
  await post({ state: "listening", until: 8 });
  const v = await get();
  assert.equal(v.listener.state, "listening");
  assert.equal(v.listener.remainingSec, 8);
  await post({ state: "sending" });
  assert.equal((await get()).listener.state, "sending");
});
