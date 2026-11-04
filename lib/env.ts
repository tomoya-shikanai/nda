import { existsSync } from "node:fs";

/** .env があれば読み込む。無ければ何もしない。すでにある環境変数は上書きしない。 */
export function loadEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
