/** .env の読み込み。値は架空。実際の .env には触れない（一時フォルダだけ）。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { loadEnv } from "../lib/env";

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const PRINT = join(ROOT, "tests/fixtures/print-env.ts");

async function tmp() {
  return mkdtemp(join(tmpdir(), "nda-env-"));
}

test("loadEnv: .env の値を読み込む", async () => {
  const dir = await tmp();
  await writeFile(join(dir, ".env"), "NDA_TEST_LOADED=fake-value\n");
  delete process.env.NDA_TEST_LOADED;
  loadEnv(join(dir, ".env"));
  assert.equal(process.env.NDA_TEST_LOADED, "fake-value");
  delete process.env.NDA_TEST_LOADED;
});

test("loadEnv: .env が無くても落ちない", async () => {
  const dir = await tmp();
  assert.doesNotThrow(() => loadEnv(join(dir, ".env")));
});

test("loadEnv: 既存の環境変数を上書きしない", async () => {
  const dir = await tmp();
  await writeFile(join(dir, ".env"), "NDA_TEST_KEEP=from-file\n");
  process.env.NDA_TEST_KEEP = "from-env";
  loadEnv(join(dir, ".env"));
  assert.equal(process.env.NDA_TEST_KEEP, "from-env");
  delete process.env.NDA_TEST_KEEP;
});

test("スクリプト経由: 作業フォルダの .env を読み、渡した ANTHROPIC_BASE_URL は上書きされない", async () => {
  const dir = await tmp();
  await writeFile(
    join(dir, ".env"),
    "NDA_TEST_KEY=from-file\nANTHROPIC_BASE_URL=http://example.invalid\n",
  );
  const env = { ...process.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:1" };
  delete (env as Record<string, string | undefined>).NDA_TEST_KEY;
  const { stdout } = await exec(TSX, [PRINT], { cwd: dir, env });
  assert.deepEqual(JSON.parse(stdout), { key: "from-file", url: "http://127.0.0.1:1" });
});
