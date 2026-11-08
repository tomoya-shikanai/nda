/**
 * 1 日の出来事の記録（events-*.jsonl と listener-*.jsonl）を集計する（scripts/log-summary.ts、docs/logging.md）。
 * 集計は純粋な関数（summarize）。読めない行は数えて飛ばす。改善の当たりを付ける「気になる点」を数行出す。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type Row = Record<string, unknown> & { kind?: unknown };

export type Stat = { n: number; median: number | null; max: number | null };

export function stat(xs: number[]): Stat {
  if (xs.length === 0) return { n: 0, median: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: s.length, median: m, max: s[s.length - 1] };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bump = (m: Record<string, number>, k: string, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};
const nums = (rows: Row[], key: string) => rows.map((r) => num(r[key])).filter((x): x is number => x !== null);

/** 起動語の conf の区切り（下限）。 */
export const WAKE_BUCKETS = [0, 0.5, 0.7, 0.8, 0.9, 0.95] as const;

export type Summary = {
  sessions: number;
  approved: number;
  approveMs: Stat;
  questions: number;
  questionReasons: Record<string, number>;
  answers: number;
  unread: number;
  unreadRate: number | null;
  unreadReasons: Record<string, number>;
  /** 答えた質問の理由ごとの [答え, unread]。 */
  unreadByQuestion: Record<string, { answers: number; unread: number }>;
  stt: Stat;
  sttAudioSec: Stat;
  extract: Stat;
  tokens: { input: number; output: number };
  officePut: Stat;
  officeRoundTrip: { query: Stat; request: Stat };
  officeReplies: Record<string, number>;
  officeOutcomes: Record<string, number>;
  queryResults: Record<string, number>;
  tts: Stat;
  failures: Record<string, number>;
  rejects: Record<string, number>;
  wake: { accepted: number; rejected: number; buckets: Record<string, number> };
  record: { sec: Stat; silent: number };
  send: { ms: Stat; results: Record<string, number> };
  conflicts409: number;
  invalidLines: number;
};

const bucketOf = (c: number) => {
  let label = "";
  for (let i = 0; i < WAKE_BUCKETS.length; i++) {
    if (c >= WAKE_BUCKETS[i]) label = i + 1 < WAKE_BUCKETS.length ? `${WAKE_BUCKETS[i]}-${WAKE_BUCKETS[i + 1]}` : `${WAKE_BUCKETS[i]}-`;
  }
  return label || "<0";
};

export function summarize(events: Row[], listener: Row[]): Summary {
  const of = (rows: Row[], kind: string) => rows.filter((r) => r.kind === kind);
  const failures: Record<string, number> = {};
  const failed = (rows: Row[], name: string) => {
    for (const r of rows) if (r.ok === false) bump(failures, `${name}:${str(r.error) ?? "?"}`);
  };

  const approvedRows = of(events, "session.approved");
  const extracts = of(events, "extract");
  const questionReasons: Record<string, number> = {};
  for (const r of extracts) {
    const qr = r.questionReasons;
    if (qr && typeof qr === "object") for (const [k, v] of Object.entries(qr)) if (num(v) !== null) bump(questionReasons, k, v as number);
  }
  // 答え: 承認・事務所への問い合わせ・話の続きは「質問への答え」に数えない
  const answers = of(events, "session.answer").filter((r) => !["approve", "askOffice", "continue"].includes(String(r.action)));
  const unreadRows = answers.filter((r) => r.action === "unread");
  const unreadReasons: Record<string, number> = {};
  for (const r of unreadRows) bump(unreadReasons, str(r.unreadReason) ?? "?");
  const unreadByQuestion: Summary["unreadByQuestion"] = {};
  for (const r of answers) {
    const k = str(r.questionReason) ?? "none";
    unreadByQuestion[k] ??= { answers: 0, unread: 0 };
    unreadByQuestion[k].answers++;
    if (r.action === "unread") unreadByQuestion[k].unread++;
  }

  const stt = of(events, "stt");
  const puts = of(events, "office.put");
  const replies = of(events, "office.reply");
  const tts = of(events, "tts");
  failed(stt, "stt");
  failed(extracts, "extract");
  failed(puts, "office.put");
  failed(tts, "tts");

  const officeReplies: Record<string, number> = {};
  for (const r of replies) bump(officeReplies, `${str(r.message)}:${str(r.result)}`);
  const officeOutcomes: Record<string, number> = {};
  for (const r of of(events, "session.office")) bump(officeOutcomes, `${str(r.outcome)}${r.reason ? `:${str(r.reason)}` : ""}`);
  const queryResults: Record<string, number> = {};
  for (const r of of(events, "session.query")) bump(queryResults, `${str(r.status)}${r.retryReason ? `:${str(r.retryReason)}` : ""}`);
  const rejects: Record<string, number> = {};
  for (const r of of(events, "route.reject")) bump(rejects, `${str(r.route)}:${str(r.reason)}`);
  const accepted = (m: string) => replies.filter((r) => r.message === m && r.result === "accepted");

  const wakes = of(listener, "wake");
  const buckets: Record<string, number> = {};
  for (const r of wakes) {
    const c = num(r.conf);
    if (c !== null) bump(buckets, bucketOf(c));
  }
  const records = of(listener, "record");
  const sends = of(listener, "send");
  const sendResults: Record<string, number> = {};
  for (const r of sends) bump(sendResults, str(r.result) ?? "?");
  for (const r of sends) if (r.result === "unreachable" || r.result === "rejected") bump(failures, `listener.send:${str(r.result)}:${num(r.status) ?? "-"}`);

  const nAnswers = answers.length;
  return {
    sessions: of(events, "session.created").length,
    approved: approvedRows.length,
    approveMs: stat(nums(approvedRows, "msFromCreated")),
    questions: Object.values(questionReasons).reduce((a, b) => a + b, 0),
    questionReasons,
    answers: nAnswers,
    unread: unreadRows.length,
    unreadRate: nAnswers ? unreadRows.length / nAnswers : null,
    unreadReasons,
    unreadByQuestion,
    stt: stat(nums(stt.filter((r) => r.ok === true), "ms")),
    sttAudioSec: stat(nums(stt, "audioSec")),
    extract: stat(nums(extracts.filter((r) => r.ok === true), "ms")),
    tokens: { input: nums(extracts, "inputTokens").reduce((a, b) => a + b, 0), output: nums(extracts, "outputTokens").reduce((a, b) => a + b, 0) },
    officePut: stat(nums(puts, "ms")),
    officeRoundTrip: { query: stat(nums(accepted("customer.answer"), "msSinceSent")), request: stat(nums(accepted("invoice.result"), "msSinceSent")) },
    officeReplies,
    officeOutcomes,
    queryResults,
    tts: stat(nums(tts.filter((r) => r.ok === true), "ms")),
    failures,
    rejects,
    wake: { accepted: wakes.filter((r) => r.accepted === true).length, rejected: wakes.filter((r) => r.accepted === false).length, buckets },
    record: { sec: stat(nums(records.filter((r) => r.spoke === true), "sec")), silent: records.filter((r) => r.spoke === false).length },
    send: { ms: stat(nums(sends, "ms")), results: sendResults },
    conflicts409: sends.filter((r) => r.status === 409).length,
    invalidLines: of(events, "log.invalid").length + of(listener, "log.invalid").length,
  };
}

const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0];

/** 改善の当たりを付ける「気になる点」。閾値は目安（docs/logging.md）。 */
export function concerns(s: Summary): string[] {
  const out: string[] = [];
  if (s.unreadRate !== null && s.answers >= 3 && s.unreadRate >= 0.3) {
    const [reason, n] = top(s.unreadReasons) ?? ["?", 0];
    out.push(`答えの unread が ${pct(s.unreadRate)}（${s.unread}/${s.answers}）。いちばん多い理由は「${reason}」（${n} 件）`);
  }
  for (const [q, v] of Object.entries(s.unreadByQuestion)) {
    if (v.answers >= 3 && v.unread / v.answers >= 0.5) out.push(`質問の理由「${q}」への答えの半分以上が unread（${v.unread}/${v.answers}）。質問文か読み方を見直す`);
  }
  const fails = Object.entries(s.failures).sort((a, b) => b[1] - a[1]);
  if (fails.length) out.push(`失敗: ${fails.map(([k, n]) => `${k} ${n}`).join("、")}`);
  if (s.extract.max !== null && s.extract.max > 30000) out.push(`抽出の最大が ${sec(s.extract.max)}（30 秒超）`);
  if (s.stt.max !== null && s.stt.max > 15000) out.push(`文字起こしの最大が ${sec(s.stt.max)}（15 秒超）`);
  if (s.officePut.max !== null && s.officePut.max > 2000) out.push(`受け箱に置くのに最大 ${sec(s.officePut.max)}（2 秒超）`);
  if ((s.queryResults.expired ?? 0) > 0) out.push(`照合の期限切れが ${s.queryResults.expired} 件（事務所の答えが 10 秒に間に合っていない）`);
  const stale = Object.entries(s.officeReplies).filter(([k]) => k.endsWith(":stale")).reduce((a, [, n]) => a + n, 0);
  if (stale > 0) out.push(`事務所の返しの stale が ${stale} 件`);
  if (s.conflicts409 > 0) out.push(`聞き役の 409 が ${s.conflicts409} 件（聞いている間に作業が変わった・質問中でなかった）`);
  const near = (s.wake.buckets["0.8-0.9"] ?? 0) + (s.wake.buckets["0.7-0.8"] ?? 0);
  if (s.wake.rejected > 0 && near >= s.wake.accepted && near > 0) {
    out.push(`起動語の conf が 0.7〜0.9 で落ちたものが ${near} 件（通ったもの ${s.wake.accepted} 件）。下限 0.9 が工場では高いかもしれない`);
  }
  if (s.record.silent > 0) out.push(`起動語の後に声が無かった録音が ${s.record.silent} 件（誤検出か、合図の後に話していない）`);
  if (s.sessions > 0 && s.approved < s.sessions) out.push(`作業 ${s.sessions} 件のうち承認は ${s.approved} 件`);
  if (s.invalidLines > 0) out.push(`形が合わずに捨てた記録が ${s.invalidLines} 行（記録する側の不具合）`);
  return out;
}

const pct = (r: number) => `${Math.round(r * 100)}%`;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
const fmt = (s: Stat, unit: "ms" | "sec" = "ms") =>
  s.n === 0 ? "なし" : `${s.n} 件、中央値 ${unit === "ms" ? sec(s.median ?? 0) : `${(s.median ?? 0).toFixed(1)} 秒`}、最大 ${unit === "ms" ? sec(s.max ?? 0) : `${(s.max ?? 0).toFixed(1)} 秒`}`;
const map = (m: Record<string, number>) => {
  const e = Object.entries(m).sort((a, b) => b[1] - a[1]);
  return e.length ? e.map(([k, n]) => `${k} ${n}`).join("、") : "なし";
};

export function formatSummary(date: string, s: Summary): string {
  const lines = [
    `# ${date}`,
    `作業: ${s.sessions} 件（承認 ${s.approved} 件）。承認までの時間: ${fmt(s.approveMs)}`,
    `聞き返し: ${s.questions} 問（${map(s.questionReasons)}）`,
    `答え: ${s.answers} 件、unread ${s.unread} 件${s.unreadRate === null ? "" : `（${pct(s.unreadRate)}）`}。理由: ${map(s.unreadReasons)}`,
    `文字起こし: ${fmt(s.stt)}。音声の長さ: ${fmt(s.sttAudioSec, "sec")}`,
    `抽出: ${fmt(s.extract)}。トークン 入力 ${s.tokens.input}・出力 ${s.tokens.output}`,
    `事務所: 置く ${fmt(s.officePut)}。照合の往復 ${fmt(s.officeRoundTrip.query)}。依頼の往復 ${fmt(s.officeRoundTrip.request)}`,
    `事務所の返し: ${map(s.officeReplies)}。照合: ${map(s.queryResults)}。入力の結果: ${map(s.officeOutcomes)}`,
    `声: ${fmt(s.tts)}`,
    `断った入口: ${map(s.rejects)}`,
    `失敗: ${map(s.failures)}`,
    `起動語: 通った ${s.wake.accepted}・落ちた ${s.wake.rejected}。conf: ${map(s.wake.buckets)}`,
    `録音: ${fmt(s.record.sec, "sec")}、声なし ${s.record.silent} 件。送信: ${fmt(s.send.ms)}（${map(s.send.results)}）。409: ${s.conflicts409} 件`,
  ];
  const c = concerns(s);
  lines.push("", "## 気になる点", ...(c.length ? c.map((x) => `- ${x}`) : ["- なし"]));
  return lines.join("\n");
}

/** JSONL を読む。無ければ空。読めない行は log.invalid として数える。 */
export async function readJsonl(file: string): Promise<Row[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        const v: unknown = JSON.parse(l);
        return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : { kind: "log.invalid" };
      } catch {
        return { kind: "log.invalid" };
      }
    });
}

export async function summarizeDay(dir: string, date: string): Promise<Summary> {
  return summarize(await readJsonl(join(dir, `events-${date}.jsonl`)), await readJsonl(join(dir, `listener-${date}.jsonl`)));
}
