/**
 * 1 日の出来事の記録を集計して出す（docs/logging.md）。自動では何も直さない。改善の当たりを付ける材料。
 * 使い方: pnpm log:summary [YYYY-MM-DD]（既定は今日）[--dir 記録の置き場]（既定は NDA_LOG_DIR）
 * 例（工場の Pi）: NDA_LOG_DIR=/var/lib/nda/logs pnpm log:summary 2026-11-08
 */
import { parseArgs } from "node:util";
import { localDate } from "../lib/log/events";
import { formatSummary, summarizeDay } from "../lib/log/summary";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: "string" } } });
const date = positionals[0] ?? localDate(new Date());
const dir = values.dir ?? process.env.NDA_LOG_DIR;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !dir) {
  console.error("usage: pnpm log:summary [YYYY-MM-DD] [--dir 記録の置き場]（--dir が無ければ NDA_LOG_DIR。Pi は /var/lib/nda/logs）");
  process.exit(1);
}
console.log(formatSummary(date, await summarizeDay(dir, date)));
