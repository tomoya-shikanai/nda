/**
 * モニター用の 1 つの JSON（W2）。純粋な関数。入力を書き換えない。
 * 金額を推測で出さない。null は null のまま返し、「値段？」の表示は画面がする。
 */
import type { ListenerView } from "../listener/state";
import { customerPending, pendingCount } from "./customer";
import { keptLines } from "./kept";
import type { Session, SessionStatus } from "./store";

export const VOICE_CREDIT = "VOICEVOX:ずんだもん";

export type MonitorLine = {
  item: string;
  qty: number | null;
  unit: string | null;
  unitPrice: number | null;
  amount: number | null;
  status: "ok" | "ask";
  answered: string[];
};

export type MonitorView = {
  id: string | null;
  state: SessionStatus;
  heard: string | null;
  say: string;
  /**
   * 台詞の通し番号（作業の id・状態の遷移の数・答えの数）。台詞が同じでも、答えが読めなかったときなどに
   * 声を出し直せるよう、画面はこれが変わったときに声を鳴らす。
   */
  sayId: string;
  /** asking で確認事項が 0 件（承認の言葉を待っている）。画面の札と表情を「承認待ち」にする。 */
  awaitingApproval: boolean;
  lines: MonitorLine[];
  total: number | null;
  questions: string[];
  confirmationCount: number;
  approved: boolean;
  /** 決まった客（名前と車）。未定・照合なし・一覧に無いなら null（画面は「お客様: 未指定」）。 */
  /**
   * 客の札（docs/design/pi-office.md §4・§9-1）。照合なしなら null（画面は「お客様: 未指定」）。
   * 決まったら label（姓と車種。メモリにだけある）か「お客様: 決まりました」。照合中・失敗はその札。
   */
  customer: string | null;
  /** 承認の後の事務所への入力の札（§4・§5）。承認の前は null。 */
  office: string | null;
  /** 依頼を受け箱に置けていない（送り直し中）。画面は状態の札を失敗の色と言葉にする（成功と同じ緑にしない）。 */
  officeTrouble: boolean;
  credit: typeof VOICE_CREDIT;
  /** 聞き役の状態（起動語の後に聞いている・送っている）。メモリにだけある（lib/listener/state.ts）。工場の本体だけが入れる。 */
  listener?: ListenerView;
};

export const SAY = {
  idle: "待っています。手は整備のままで。",
  error: "うまく分けられませんでした。もう一度話してください",
  listening: "聞いています",
  thinking: "明細に分けています",
  drafting: "請求書を作っています",
  askApprove: "合っていれば「請求書頼む」と言ってください",
  /** 会話の受け皿で「やめる」と言われて作業を閉じた。 */
  cancelled: "この作業をやめました",
  /** 答えが読めなかった（unread）ときの前置き。続けて今の質問を言い直す。 */
  retry: (q: string) => `もう一度お願いします。${q}`,
  /** 確認事項が残っているのに承認の言葉を言ったとき。 */
  notYet: (q: string) => `まだ確かめたいことがあります。${q}`,
  /** 事務所がつながっていない作業の承認（入力は人がする）。 */
  done: (n: number) => `${n}行の請求書を承認しました。入力は人がしてください`,
  // 事務所への入力（§4・§5）
  submit: "承認しました。事務所に送ります",
  sending: "事務所に送っています",
  sendFailed: (reason: string | null) => `承認しました。事務所に届きません（${unreachableReason(reason)}）。つながったら送ります`,
  sent: "事務所に届きました。入れています",
  /** 声の指示の道（#56）: 事務所は返しを送らない。 */
  sentInstruction: "事務所に送りました。保存は人が押してください",
  entered: (n: number) => `${n}行入れました。保存は人が押してください`,
  stopped: (reason: string | null) =>
    reason === "busy"
      ? "事務所のソフトが使用中でした。人が入れてください"
      : reason === "appNotRunning"
        ? "事務所のソフトが開いていません"
        : reason === "noClue"
          ? "お客様の手がかりが消えたので送りませんでした。お客様の名前とナンバーの下4桁をもう一度お願いします"
          : "事務所で止まりました。人が入れてください",
  // 客の照合（§4）
  checking: "お客様を事務所で確かめています",
  noReply: "事務所から返事がありません。名前とナンバーの下4桁をもう一度お願いします",
  /** 受け箱（事務所の PC の共有フォルダ）に置けなかった。札・帯・声で「事務所に届きません」にそろえ、理由は声の側に入れる。 */
  unreachable: (reason: string | null) => `事務所に届きません（${unreachableReason(reason)}）。お客様はあとでもう一度聞きます`,
  notFound: "お客様が決まりませんでした。名前とナンバーの下4桁をもう一度お願いします",
} as const;

/** 客の質問が今の質問のときの声（照合中・失敗）。当てはまらなければ null。 */
function customerSay(s: Session): string | null {
  if (s.questions[0]?.reason !== "customer" || !customerPending(s)) return null;
  const q = s.customerQuery;
  if (q === null) return null;
  if (q.status === "pending") return SAY.checking;
  if (q.status === "expired") return SAY.noReply;
  if (q.status === "unreachable") return SAY.unreachable(q.retryReason);
  if (q.status === "answered" && q.retryReason !== null) return SAY.notFound;
  return null;
}

/** 受け箱（事務所の PC の共有フォルダ）に置けなかった理由（§4・§9-4）。見えない・書けないを分ける。 */
function unreachableReason(reason: string | null): string {
  return reason === "boxMissing" ? "共有フォルダが見えません" : "書き込めません";
}

/** 依頼の置けなかった理由（office.lastError の種類名から）。 */
const sendFailReason = (lastError: string) => (lastError.includes("BoxMissingError") ? "boxMissing" : "writeFailed");

function customerBadge(s: Session | null, label: string | null): string | null {
  if (s === null || !s.customerRequired) return null;
  if (s.customer !== null) return label === null ? "お客様: 決まりました" : `お客様: ${label}`;
  if (s.customerClueAt) return "お客様: 受けました（事務所で確かめます）";
  const q = s.customerQuery;
  if (q?.status === "pending") return "お客様: 確かめています…";
  if (q?.status === "expired") return "お客様: 事務所から返事がありません";
  if (q?.status === "unreachable") return "お客様: 事務所に届きません";
  if (q?.status === "answered" && q.retryReason) return "お客様: 決まりませんでした";
  return "お客様: 未指定";
}

/** 確認事項の帯の「✓ 承認済み」の後ろに出す短い札（吹き出しの文と同じことを二重に言わない）。 */
function officeBadge(s: Session | null): string | null {
  if (s === null) return null;
  switch (s.status) {
    case "done":
      return s.customerRequired ? "これから送る" : null;
    case "sending":
      return s.office?.lastError ? "未送信・つながったら送ります" : "送信中";
    case "sent":
      return "事務所に届いた";
    case "entered":
      return "業務ソフトに入った";
    case "stopped": {
      const r = s.office?.result?.reason ?? null;
      if (r === "busy") return "止まった: ソフトが使用中";
      if (r === "appNotRunning") return "止まった: ソフトが開いていない";
      if (r === "unknownItem") return "止まった: 品目が見つからない";
      if (r === "noClue") return "止まった: お客様の手がかりが無い";
      return "止まった";
    }
    default:
      return null;
  }
}

/** talk は会話の受け皿の声の文（メモリにだけある。lib/session/talk.ts）。 */
function sayOf(s: Session | null, talk: string | null): string {
  if (s === null) return SAY.idle;
  if (s.error !== null) return SAY.error;
  const last = s.answers.at(-1);
  switch (s.status) {
    case "idle":
      return last?.action.kind === "talk" && last.action.intent === "cancel" ? SAY.cancelled : SAY.idle;
    case "listening":
      return SAY.listening;
    case "thinking":
      return SAY.thinking;
    case "drafting":
      return SAY.drafting;
    case "asking": {
      const office = customerSay(s);
      if (office !== null) return office;
      const ask = s.questions[0]?.text ?? SAY.askApprove;
      // 会話の受け皿で受けた返事は、その声の文（メモリから消えていれば聞き直し）
      if (last?.action.kind === "talk") return talk ?? SAY.retry(ask);
      // 最後の答えが読めなかった・承認の言葉が効かなかったなら、そう言ってから聞き直す
      if (last?.action.kind !== "unread") return ask;
      return last.action.reason === "確認事項が残っている" ? SAY.notYet(ask) : SAY.retry(ask);
    }
    case "done":
      return s.customerRequired ? SAY.submit : SAY.done(s.invoice?.lines.length ?? 0);
    case "sending":
      return s.office?.lastError ? SAY.sendFailed(sendFailReason(s.office.lastError)) : SAY.sending;
    case "sent":
      return s.office?.message === "estimate.instruction" ? SAY.sentInstruction : SAY.sent;
    case "entered":
      return SAY.entered(s.office?.result?.enteredLines ?? 0);
    case "stopped":
      return SAY.stopped(s.office?.result?.reason ?? null);
  }
}

/** 金額の表示（¥3,300）。計算はしない。null は null のまま返す（「値段？」などの言葉は画面が選ぶ） */
export function yenText(n: number | null): string | null {
  return n === null ? null : `¥${n.toLocaleString("ja-JP")}`;
}

const NOT_ANSWERS = new Set(["unread", "approve", "continue", "askOffice", "customerClue", "talk"]);

/**
 * label は事務所が返した客の姓と車種（メモリにだけある。lib/office/labels.ts）。無ければ「決まりました」。
 * talk は会話の受け皿の声の文（メモリにだけある。lib/session/talk.ts の getTalkSay）。
 */
export function toMonitorView(s: Session | null, label: string | null = null, talk: string | null = null): MonitorView {
  const segs = s?.transcript?.segments ?? [];
  const confirmations = s?.invoice?.confirmations ?? [];
  const answers = s?.answers ?? [];
  // 答えの lineIndex は行を除く前の添字。明細の i 行目の元の添字で引く
  const kept = s?.refs ? keptLines(s.refs.lines.length, answers) : [];
  const lines: MonitorLine[] = (s?.invoice?.lines ?? []).map((l, i) => ({
    item: l.item,
    qty: l.qty,
    unit: l.unit,
    unitPrice: l.unitPrice,
    amount: l.amount,
    status: confirmations.some((c) => c.lineIndex === i) ? "ask" : "ok",
    answered: answers
      .filter((a) => kept[i] !== undefined && a.lineIndex === kept[i] && !NOT_ANSWERS.has(a.action.kind))
      .map((a) => a.provenance.quote),
  }));
  return {
    id: s?.id ?? null,
    state: s?.status ?? "idle",
    heard: segs.length ? segs.map((x) => x.text).join("") : null,
    say: sayOf(s, talk),
    // 照合の札・依頼の失敗が変わったときも声を出し直す（状態の遷移が無くても）
    sayId:
      s === null
        ? "none"
        : `${s.id}:${s.history.length}:${s.answers.length}:${s.customerQuery?.status ?? "-"}${s.customerQuery?.retryReason ?? ""}:${s.customer ? "c" : "-"}:${s.office?.lastError ? "e" : "-"}`,
    awaitingApproval: s?.status === "asking" && s.invoice !== null && pendingCount(s) === 0,
    lines,
    total: s?.invoice?.total ?? null,
    questions: (s?.questions ?? []).map((q) => q.text),
    confirmationCount: s ? pendingCount(s) : 0,
    approved: s?.approved ?? false,
    customer: customerBadge(s, label),
    office: officeBadge(s),
    officeTrouble: s?.status === "sending" && Boolean(s.office?.lastError),
    credit: VOICE_CREDIT,
  };
}
