/**
 * 作業 1 件の状態の保存（lib/session/store.ts）の検証。素材は架空のもの。data/ は読まない。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  type Answer,
  latestSession,
  newSession,
  readSession,
  type Session,
  type SessionStatus,
  transition,
  writeSession,
} from "../lib/session/store";

const made: string[] = [];
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nda-session-"));
  made.push(d);
  return d;
}

const t0 = new Date("2026-11-04T10:00:00.000Z");
const at = (sec: number) => new Date(t0.getTime() + sec * 1000);

function sample(id = "s1"): Session {
  const answer: Answer = {
    at: at(5).toISOString(),
    questionIndex: 0,
    lineIndex: 3,
    provenance: { recordingId: "rec-x", startSec: 1, endSec: 2, speaker: "father", quote: "1 個 330 円" },
    source: "answer",
    action: { kind: "setUnitPrice", value: 330 },
  };
  return {
    ...newSession(id, t0),
    transcript: { recordingId: "rec-x", segments: [] } as unknown as Session["transcript"],
    answers: [answer],
  };
}

test("書いて読むと同じ", async () => {
  const dir = await tmp();
  const s = sample();
  await writeSession(dir, s);
  assert.deepEqual(await readSession(dir, s.id), s);
  assert.equal(await readSession(dir, "nothing"), null);
});

test("許す遷移を通ると history が 8 件で at が now", () => {
  const steps: SessionStatus[] = ["listening", "thinking", "drafting", "asking", "drafting", "asking"];
  let s = newSession("s2", t0);
  steps.forEach((to, i) => {
    s = transition(s, to, at(i + 1));
  });
  s = { ...s, approved: true, approvedAt: at(7).toISOString(), invoice: { lines: [], confirmations: [], total: 0, unused: [] } };
  s = transition(s, "done", at(7));
  assert.equal(s.status, "done");
  assert.equal(s.history.length, 8);
  assert.deepEqual(
    s.history.map((h) => h.status),
    ["idle", ...steps, "done"],
  );
  s.history.forEach((h, i) => assert.equal(h.at, at(i).toISOString()));
  assert.equal(s.updatedAt, at(7).toISOString());
  // thinking→idle（抽出の失敗）も許す
  const failed = transition(transition(transition(newSession("s3", t0), "listening", at(1)), "thinking", at(2)), "idle", at(3));
  assert.equal(failed.status, "idle");
});

test("許さない遷移は throw", () => {
  const idle = newSession("s4", t0);
  assert.throws(() => transition(idle, "asking", at(1)));
  const listening = transition(idle, "listening", at(1));
  assert.throws(() => transition(listening, "done", at(2)));
  let s = transition(listening, "thinking", at(2));
  s = transition(s, "drafting", at(3));
  s = transition(s, "asking", at(4));
  assert.throws(() => transition(s, "done", at(5)), /承認/);
  // 承認されていても、確認事項が残っている・明細が無いなら done にしない
  const conf = { lineIndex: 0, item: "x", field: "qty" as const, message: "「x」の数量が分からない" };
  assert.throws(
    () => transition({ ...s, approved: true, invoice: { lines: [], confirmations: [conf], total: null, unused: [] } }, "done", at(5)),
    /確認事項/,
  );
  assert.throws(() => transition({ ...s, approved: true, invoice: null }, "done", at(5)), /確認事項/);
  const done = transition({ ...s, approved: true, invoice: { lines: [], confirmations: [], total: 0, unused: [] } }, "done", at(5));
  assert.throws(() => transition(done, "idle", at(6)));
});

test("transition は入力を書き換えない", () => {
  const s = sample();
  const before = structuredClone(s);
  transition(s, "listening", at(1));
  assert.deepEqual(s, before);
});

test("不正な ID は read と write が throw し、フォルダの外にファイルができない", async () => {
  // 一時フォルダ全体は他の物で汚れていることがあるので、専用の外側のフォルダだけを見る
  const outer = join(await tmp(), "outer");
  const dir = join(outer, "inner", "sessions");
  await mkdir(dir, { recursive: true });
  for (const id of ["../x", "../../x", "a/b", "", "a".repeat(65)]) {
    const s = { ...sample(), id };
    await assert.rejects(writeSession(dir, s));
    await assert.rejects(readSession(dir, id));
  }
  assert.deepEqual(await readdir(outer), ["inner"]);
  assert.deepEqual(await readdir(join(outer, "inner")), ["sessions"]);
  assert.deepEqual(await readdir(dir), []);
});

test("書いた後に .tmp が残らず、並べて書いても壊れない", async () => {
  const dir = await tmp();
  await writeSession(dir, sample("one"));
  assert.deepEqual(await readdir(dir), ["one.json"]);

  const versions = Array.from({ length: 20 }, (_, i) => ({ ...sample("race"), error: `v${i}`, updatedAt: at(i).toISOString() }));
  await Promise.all(versions.map((v) => writeSession(dir, v)));
  const got = await readSession(dir, "race");
  assert.ok(got);
  assert.ok(versions.some((v) => { try { assert.deepEqual(got, v); return true; } catch { return false; } }));
  assert.deepEqual((await readdir(dir)).sort(), ["one.json", "race.json"]);
});

test("latestSession は updatedAt の最新を返し、空・無いフォルダで null", async () => {
  const dir = await tmp();
  assert.equal(await latestSession(dir), null);
  assert.equal(await latestSession(join(dir, "missing")), null);
  const a = { ...newSession("a", at(0)), updatedAt: at(10).toISOString() };
  const b = { ...newSession("b", at(0)), updatedAt: at(30).toISOString() };
  const c = { ...newSession("c", at(0)), updatedAt: at(20).toISOString() };
  for (const s of [a, b, c]) await writeSession(dir, s);
  assert.deepEqual(await latestSession(dir), b);
});

test("読み込みで壊れたファイルを受け入れない: ファイル名と中の id が違う、done なのに未承認・確認事項あり", async () => {
  const dir = await tmp();
  await writeSession(dir, sample("a"));
  const raw = JSON.parse(await readFile(join(dir, "a.json"), "utf8"));
  await writeFile(join(dir, "a.json"), JSON.stringify({ ...raw, id: "b" }));
  await assert.rejects(readSession(dir, "a"), /id が違う/);
  await assert.rejects(latestSession(dir), /id が違う/);

  const done = (over: Partial<Session>): Session => ({
    ...newSession("d", t0),
    status: "done",
    approved: true,
    invoice: { lines: [], confirmations: [], total: 0, unused: [] },
    ...over,
  });
  const dir2 = await tmp();
  await writeSession(dir2, done({}));
  assert.equal((await readSession(dir2, "d"))?.status, "done");
  // 壊れた done は writeSession が書かない。ファイルを直接書いて、読み込みでも受け入れないことを見る
  const conf = { lineIndex: 0, item: "x", field: "qty" as const, message: "「x」の数量が分からない" };
  const broken = [
    done({ approved: false }),
    done({ invoice: { lines: [], confirmations: [conf], total: null, unused: [] } }),
    done({ invoice: null }),
  ];
  for (const b of broken) {
    await assert.rejects(writeSession(dir2, b), /done なのに/);
    await writeFile(join(dir2, "d.json"), JSON.stringify(b));
    await assert.rejects(readSession(dir2, "d"), /done なのに/);
  }
});

test("前の版のファイル（extraction が無い）は extraction null として読む", async () => {
  const dir = await tmp();
  const { extraction, ...old } = sample("old");
  assert.equal(extraction, null);
  await writeFile(join(dir, "old.json"), JSON.stringify(old));
  assert.deepEqual(await readSession(dir, "old"), sample("old"));
});
