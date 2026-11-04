/**
 * 請求の明細の検証。Claude は偽サーバーで置き換える。モデルの品質は検証しない。
 * 確かめるのは、明細の出所と単価を文字起こしと機械的に突き合わせる部分。
 * 素材は架空で、実案件・証明には使わない。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { extractInvoice } from "../lib/invoice/extract";
import type { InvoiceDraft, InvoiceLine } from "../lib/invoice/schema";
import { verifyInvoice } from "../lib/invoice/verify";
import type { LedgerEntry } from "../lib/ledger/lookup";
import type { Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const transcripts = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/tire-transcripts.json"), "utf8"),
) as Transcript[];
// 品目は料金表の正式名で書くので、別名（発話の言い方）を引くために料金表を渡す
const ledger = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8"),
) as LedgerEntry[];
const byId = (id: string) => {
  const t = transcripts.find((x) => x.recordingId === id);
  if (!t) throw new Error(`素材に無い: ${id}`);
  return t;
};

const line = (
  recordingId: string,
  item: string,
  qty: number | null,
  unit: string | null,
  unitPrice: number | null,
  startSec: number,
  endSec: number,
  quote: string,
  speaker: InvoiceLine["provenance"]["speaker"] = "father",
): InvoiceLine => ({
  item,
  qty,
  unit,
  unitPrice,
  provenance: { recordingId, startSec, endSec, speaker, quote },
});

/** 文字起こしに合う明細。 */
const good: Record<string, InvoiceDraft> = {
  "tire-001": {
    lines: [
      line("tire-001", "タイヤ脱着", 4, "本", null, 0, 5, "冬タイヤさ履き替えるはんで、脱着4本な。"),
      line("tire-001", "ホイールバランス", 4, "本", null, 5, 9, "バランスも4本取っておぐ。"),
    ],
  },
  "tire-002": {
    lines: [
      line("tire-002", "タイヤ組替", 4, "本", null, 0, 6, "組替4本"),
      line("tire-002", "ホイールバランス", 4, "本", null, 6, 10, "バランス4本"),
      line("tire-002", "エアバルブ交換", 4, "本", 330, 6, 13, "ゴムバルブも4本替える。ゴムバルブは1本330円。"),
      line("tire-002", "廃タイヤ処分", 4, "本", null, 13, 17, "廃タイヤ4本。"),
    ],
  },
  "tire-003": {
    lines: [
      line("tire-003", "タイヤ脱着", 4, "本", null, 0, 5, "スタッドレスさ履き替え、脱着4本。", "unknown"),
      line("tire-003", "ホイールナット", 2, "個", null, 5, 10, "ホイールナットも2個替える。", "unknown"),
    ],
  },
};

let server: Server;
let received: Record<string, unknown>[] = [];
let reply: unknown = null;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg",
          type: "message",
          role: "assistant",
          model: "fake",
          content: [{ type: "text", text: JSON.stringify(reply) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  // claude() は最初の呼び出しで環境変数を読むので、extractInvoice より前に設定する
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${addr.port}`;
});
after(() => server.close());

test("抽出: 偽サーバーの明細が戻り値になり、要求に全発話と出力形式が入る", async () => {
  for (const t of transcripts) {
    received = [];
    reply = good[t.recordingId];
    const got = await extractInvoice(t, { itemNames: ["タイヤ脱着", "ホイールバランス"] });
    assert.deepEqual(got, good[t.recordingId]);
    assert.equal(received.length, 1);
    const req = received[0];
    const sent = JSON.stringify(req.messages);
    assert.match(sent, new RegExp(`録音 ID: ${t.recordingId}`));
    assert.match(sent, /タイヤ脱着/);
    for (const s of t.segments) assert.ok(sent.includes(s.text), `発話が要求に無い: ${s.text}`);
    const oc = req.output_config as { format?: { type?: string } } | undefined;
    assert.ok(oc?.format, "output_config.format が無い");
    assert.equal(oc.format.type, "json_schema");
    assert.match(String(req.system), /推測で埋めない/);
  }
});

test("抽出: 料金表が無ければ「なし」と伝える", async () => {
  received = [];
  reply = good["tire-001"];
  await extractInvoice(byId("tire-001"));
  assert.match(JSON.stringify(received[0].messages), /料金表の品目名: なし/);
});

test("抽出: 解釈できない出力は throw する", async () => {
  reply = { lines: "壊れた" };
  await assert.rejects(extractInvoice(byId("tire-001")));
});

test("後検証: 3 件とも文字起こしに合う明細は合格", () => {
  for (const t of transcripts) assert.deepEqual(verifyInvoice(good[t.recordingId], t, ledger), [], t.recordingId);
  const valve = good["tire-002"].lines.find((l) => l.item === "エアバルブ交換");
  assert.equal(valve?.unitPrice, 330);
});

test("後検証: 文字起こしに無い引用は不合格", () => {
  const bad = structuredClone(good["tire-001"]);
  bad.lines[0].provenance.quote = "アライメントも取る";
  assert.match(verifyInvoice(bad, byId("tire-001"), ledger).join(), /文字起こしに無い/);
});

test("後検証: 時刻が離れた引用は不合格", () => {
  const bad = structuredClone(good["tire-002"]);
  bad.lines[3].provenance = { ...bad.lines[3].provenance, startSec: 0, endSec: 3 };
  assert.match(verifyInvoice(bad, byId("tire-002"), ledger).join(), /文字起こしに無い/);
});

test("後検証: 録音 ID が違う引用は不合格", () => {
  const bad = structuredClone(good["tire-001"]);
  bad.lines[0].provenance.recordingId = "tire-002";
  assert.match(verifyInvoice(bad, byId("tire-001"), ledger).join(), /録音 ID が違う/);
});

test("後検証: 時刻範囲が逆の引用は不合格", () => {
  const bad = structuredClone(good["tire-001"]);
  bad.lines[0].provenance = { ...bad.lines[0].provenance, startSec: 5, endSec: 0 };
  assert.match(verifyInvoice(bad, byId("tire-001"), ledger).join(), /時刻範囲が不正/);
});

test("後検証: 話者情報の無い tire-003 で話者を father にすると不合格", () => {
  const bad = structuredClone(good["tire-003"]);
  bad.lines[0].provenance.speaker = "father";
  assert.match(verifyInvoice(bad, byId("tire-003"), ledger).join(), /話者を father と推定/);
});

test("推測で埋めない: 発話に金額が無い行に単価を入れると不合格、null なら合格", () => {
  const t = byId("tire-003");
  const bad = structuredClone(good["tire-003"]);
  const nut = bad.lines.find((l) => l.item === "ホイールナット");
  assert.ok(nut);
  nut.unitPrice = 220;
  const failures = verifyInvoice(bad, t, ledger);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /単価が発話に無い/);

  nut.unitPrice = null;
  assert.deepEqual(verifyInvoice(bad, t, ledger), []);
});

test("推測で埋めない: 料金表の値を単価に写しても、発話に無ければ不合格", () => {
  const bad = structuredClone(good["tire-002"]);
  bad.lines[0].unitPrice = 1650; // 料金表のタイヤ組替の値。発話には無い
  assert.match(verifyInvoice(bad, byId("tire-002"), ledger).join(), /単価が発話に無い/);
});
