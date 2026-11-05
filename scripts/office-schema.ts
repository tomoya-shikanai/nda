/**
 * 事務所の Python 用に、lib/office/schema.ts の zod から JSON Schema を書き出す（手で二重に書かない）。
 * 使い方: pnpm office:schema（出力は office/box/schema/<名前>.json）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { SCHEMAS } from "../lib/office/schema";

export function officeJsonSchemas(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(SCHEMAS).map(([name, s]) => [name, z.toJSONSchema(s, { io: "input" })]));
}

async function main() {
  const dir = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "office", "box", "schema"));
  await mkdir(dir, { recursive: true });
  for (const [name, schema] of Object.entries(officeJsonSchemas())) {
    await writeFile(join(dir, `${name}.json`), `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  }
  console.log(`書き出した: ${dir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
