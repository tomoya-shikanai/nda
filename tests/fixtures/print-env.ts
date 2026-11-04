// env.test.ts から作業フォルダを変えて起動される。.env を読んだ後の値を出す。
import "../../lib/env-auto";

console.log(JSON.stringify({ key: process.env.NDA_TEST_KEY ?? null, url: process.env.ANTHROPIC_BASE_URL ?? null }));
