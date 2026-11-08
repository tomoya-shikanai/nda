/**
 * 会話の受け皿。父の返事が答えとして読めなかったとき（unread、明細 0 行の続きでも何も増えなかったとき）に、
 * Claude で意図だけを読み、短く答えてから今の質問に戻る。
 * Claude は何も書き換えない。数・明細・客・承認を変えるのはコードだけ。Claude の文を使うのは other のときだけで、
 * 4 桁以上の数が入っていたら捨てる。客の名前・ナンバーは Claude に渡さない（父の発話は伏せ字の後の文、状態は客を受けたかどうかだけ）。
 * 声の文は作業ファイルにもログにも残さず、メモリにだけ持つ（客の手がかりを読み上げるため。labels.ts と同じ扱い）。
 */
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { claude, MODEL_TALK } from "../claude";
import type { CustomerClue } from "../office/clues";
import type { Session } from "./store";
import { SAY } from "./view";

export const TALK_INTENTS = ["ask_customer", "ask_lines", "ask_total", "ask_next", "cancel", "other"] as const;
export type TalkIntent = (typeof TALK_INTENTS)[number];

export const TalkOutput = z.object({
  intent: z.enum(TALK_INTENTS),
  reply: z.string().describe("60 字まで。ずんだもんの口調で丁寧に、です・ます。数・値段・名前を言わない"),
});
export type TalkOutput = z.infer<typeof TalkOutput>;

/** Claude に渡す今の状態（客の中身は入れない）。 */
export type TalkState = {
  lines: { item: string; qty: number | null; unit: string | null; unitPrice: number | null; amount: number | null }[];
  total: number | null;
  confirmations: number;
  question: string;
  customerReceived: boolean;
  awaitingApproval: boolean;
};
export type TalkInput = { utterance: string; state: TalkState };
export type Talker = (x: TalkInput) => Promise<TalkOutput>;

/** Claude の期限。過ぎたら今の聞き直しに落とす。 */
export const TALK_TIMEOUT_MS = 4000;
export const TALK_REPLY_MAX = 60;

const SYSTEM = `あなたは青森市の自動車整備工場で、整備士（父）の請求書づくりを声で手伝う「ずんだもん」です。
父は今の質問に決まった形で答えませんでした。父の発話と、今の作業の状態が渡されます。父の意図を 1 つ選んでください。
- ask_customer: どのお客様の作業か、客が誰になっているかを聞いている
- ask_lines: 今の明細（何の作業が入っているか）を聞いている
- ask_total: 今の合計・いくらかを聞いている
- ask_next: 何を答えればよいか、今何を聞かれているかを聞いている（「何？」「もう一回」の類も）
- cancel: この作業をやめる・やり直す・取り消すと言っている
- other: 上のどれでもない
reply は other のときだけ使われます。守ること:
- 60 字まで。ずんだもんの口調で丁寧に、です・ます。
- 数字・値段・数量・客の名前・ナンバーを言わない。分からないことを推測で言わない。
- 明細や客を変えたと言わない（あなたは何も変えられません）。
- 今の質問は後でコードが続けて言うので、reply に質問を書き写さない。`;

function stateText(s: TalkState): string {
  const lines = s.lines.length
    ? s.lines.map((l) => `- ${l.item} 数量:${l.qty ?? "?"}${l.unit ?? ""} 単価:${l.unitPrice ?? "?"} 金額:${l.amount ?? "?"}`).join("\n")
    : "（まだ無い）";
  return [
    `明細:\n${lines}`,
    `合計: ${s.total ?? "まだ決まっていない"}`,
    `確認事項: ${s.confirmations} 件`,
    `今の質問: ${s.question}`,
    `お客様の手がかり: ${s.customerReceived ? "受けた" : "まだ"}`,
    `承認待ち: ${s.awaitingApproval ? "はい" : "いいえ"}`,
  ].join("\n");
}

/** 本物の Claude。キーが無ければすぐ投げる（呼ぶ側が聞き直しに落とす）。 */
export const claudeTalker: Talker = async (x) => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY が無い");
  const res = await claude().messages.parse(
    {
      model: MODEL_TALK,
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text: `父の発話: ${x.utterance}\n\n${stateText(x.state)}` }] }],
      output_config: { format: zodOutputFormat(TalkOutput) },
    },
    { timeout: TALK_TIMEOUT_MS, maxRetries: 0 },
  );
  if (!res.parsed_output) throw new Error(`会話の出力を解釈できない (stop_reason=${res.stop_reason})`);
  return res.parsed_output;
};

/** 期限つきで呼ぶ。期限を過ぎたら TimeoutError を投げる。 */
export async function talkWithTimeout(talk: Talker, x: TalkInput, ms = TALK_TIMEOUT_MS): Promise<TalkOutput> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error("会話の期限切れ");
      e.name = "TimeoutError";
      reject(e);
    }, ms);
  });
  try {
    return TalkOutput.parse(await Promise.race([talk(x), timeout]));
  } finally {
    clearTimeout(timer);
  }
}

/** 今の質問（view.ts の asking と同じ）。 */
export const currentQuestion = (s: Session): string => s.questions[0]?.text ?? SAY.askApprove;

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

/** 明細の文（コードが作る）。 */
export function linesText(s: Session): string {
  const lines = s.invoice?.lines ?? [];
  if (lines.length === 0) return "まだ明細はありません";
  return `${lines.map((l) => `${l.item}${l.qty === null ? "" : ` ${l.qty}${l.unit ?? ""}`}`).join("、")}、${totalText(s)}`;
}

/** 合計の文（コードが作る。推測で出さない）。 */
export function totalText(s: Session): string {
  const total = s.invoice?.total ?? null;
  return total === null ? "合計はまだ決まっていません" : `合計 ${yen(total)}です`;
}

/** 客の文。手がかりは受けた言葉をそのまま読み上げる（工場の画面と声の中だけ）。 */
export function customerText(s: Session, clue: CustomerClue | null, label: string | null): string {
  if (s.customer !== null) return label === null ? "お客様は決まっています" : `お客様は${label}です`;
  if (clue !== null) return `${clue.customerWords ? `${clue.customerWords}、` : ""}ナンバー${clue.plateNo} として受けました`;
  return "まだお客様を聞いていません";
}

/** やめる・やり直しの語。Claude が cancel と読んでも、この語が無ければ作業を閉じない。 */
const CANCEL_CUES = ["やめ", "止め", "やり直", "キャンセル", "中止", "取りやめ"];
/** 打ち消し（「やめないで続けて」「まだやめない」）。あれば閉じない。 */
const CANCEL_NEGATIONS = ["ないで", "ずに", "続け", "まだ", "待って", "やめない", "止めない"];

/**
 * Claude が cancel と読んだ返事をどうするか。取り消しの合図があり打ち消しが無ければ close、それ以外は ask（閉じずに聞き返す）。
 */
export function cancelDecision(text: string): "close" | "ask" {
  const cue = CANCEL_CUES.some((w) => text.includes(w));
  const neg = CANCEL_NEGATIONS.some((w) => text.includes(w));
  return cue && !neg ? "close" : "ask";
}

/** 聞き返しへの返事として閉じてよい言葉（「やめる」「はい、やめる」の類）だけ。 */
export const isCancelConfirm = (text: string) =>
  /^(はい|うん|ええ)?[、,\s]*(やめる|やめます|やめて|やめ|中止|キャンセル)[。！!]?$/.test(text.trim());

export const TALK_SAY = {
  cancelled: SAY.cancelled,
  sorry: "すみません、もう一度お願いします",
  askCancel: "やめますか？「やめる」と言ってください",
} as const;

/** 数字（算用・全角・漢数字）。 */
const DIGIT = /[0-9０-９〇零一二三四五六七八九十百千万億]/;

/** Claude の文を使ってよいか。数字が 1 字でもある文・長すぎる文は捨てる（数を言うのは ask_lines・ask_total のコードの文だけ）。 */
export function safeReply(reply: string): string | null {
  const t = reply.trim();
  if (t === "" || t.length > TALK_REPLY_MAX) return null;
  if (DIGIT.test(t)) return null;
  return t;
}

/** 客を指す語（この後ろの語は名前・ナンバーとして伏せる）。 */
const CUSTOMER_CUES = "顧客は|お客さんは|お客様は|お客は|客は|ナンバーは|ナンバー";

/**
 * 会話の受け皿（Claude）に渡す文。工場の伏せ字の後、さらに数字（算用・全角・漢数字）をすべて ＊ にし、
 * 「顧客は／お客さんは／客は／ナンバーは」の後ろの語を読点・句点・「だっけ」・「？」まで伏せる。
 * 敬称の無い姓（客を指す語の無い文）は残る（docs/anonymization.md の既知の限界）。
 */
export function talkText(text: string): string {
  const digits = text.replace(new RegExp(DIGIT.source, "g"), "＊");
  return digits.replace(new RegExp(`(${CUSTOMER_CUES})(.*?)(?=だっけ|[、。,.？?！!]|$)`, "g"), (_, cue: string, rest: string) =>
    rest === "" ? cue : `${cue}＊`,
  );
}

/** 文の終わりに「。」を付けてから次の文をつなぐ。 */
const join2 = (a: string, b: string) => `${/[。！？!?]$/.test(a) ? a : `${a}。`}${b}`;

/** 意図から声の文を作る（cancel 以外は最後に今の質問を続ける）。 */
export function talkSay(intent: TalkIntent, reply: string, s: Session, clue: CustomerClue | null, label: string | null): string {
  const q = currentQuestion(s);
  switch (intent) {
    case "ask_customer":
      return join2(customerText(s, clue, label), q);
    case "ask_lines":
      return join2(linesText(s), q);
    case "ask_total":
      return join2(totalText(s), q);
    case "ask_next":
      return q;
    case "cancel":
      // 閉じた作業の声は view.ts（SAY.cancelled）。ここに来るのは閉じずに聞き返すとき
      return TALK_SAY.askCancel;
    case "other":
      return join2(safeReply(reply) ?? TALK_SAY.sorry, q);
  }
}

// 声の文はメモリにだけ持つ（作業 id と答えの数で引く。再起動で消えたら画面は聞き直しの文に戻る）
const KEY = Symbol.for("nda.session.talk");
type Store = Map<string, string>;
function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  g[KEY] ??= new Map();
  return g[KEY];
}
const keyOf = (id: string, answers: number) => `${id}:${answers}`;

export function setTalkSay(sessionId: string, answers: number, say: string): void {
  const m = store();
  for (const k of m.keys()) if (k.startsWith(`${sessionId}:`)) m.delete(k);
  m.set(keyOf(sessionId, answers), say);
}

export function getTalkSay(s: Session | null): string | null {
  return s === null ? null : (store().get(keyOf(s.id, s.answers.length)) ?? null);
}

/** 試験用。 */
export function clearTalkSays(): void {
  store().clear();
}
