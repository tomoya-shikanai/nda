// モニターの 6 つの状態（承認の後の 4 つは表情を借りる）と、試作（?mock=1）で見せる架空の中身。状態の並びは lib/session/store.ts が正。

import type { SessionStatus } from "../../lib/session/store";
import { HEARD } from "../_demo/tire-change";

/** 試作の画面と相棒の表情を持つ 6 つの状態。承認の後の 4 つ（事務所への入力）は FACE_OF で表情を借りる。 */
export const STATE_KEYS = ["idle", "listening", "thinking", "drafting", "asking", "done"] as const satisfies readonly SessionStatus[];
export type StateKey = (typeof STATE_KEYS)[number];

/** 承認の後の状態の札（docs/design/pi-office.md §5）と、借りる表情。 */
export const AFTER_LABELS: Record<Exclude<SessionStatus, StateKey>, string> = {
  sending: "事務所に送っている",
  sent: "事務所で入れている",
  entered: "入れた",
  stopped: "事務所で止まった",
};
const FACE_OF: Record<Exclude<SessionStatus, StateKey>, StateKey> = {
  sending: "drafting",
  sent: "drafting",
  entered: "done",
  stopped: "asking",
};

/** 作業の状態から相棒の表情。承認待ちは awaiting。 */
export function faceOf(state: SessionStatus, awaiting: boolean): FaceKey {
  if (awaiting) return "awaiting";
  return (STATE_KEYS as readonly string[]).includes(state) ? (state as StateKey) : FACE_OF[state as Exclude<SessionStatus, StateKey>];
}

/** 作業の状態（と承認待ち・依頼を置けていない）の札。 */
export type LabelKey = SessionStatus | "awaiting" | "trouble";
/** 依頼を受け箱に置けていない（送り直し中）ときの状態の札。 */
export const TROUBLE_LABEL = "事務所に届きません";

/**
 * 画面の札と相棒の表情の種類。作業の状態に、asking のうち確認事項が 0 件の「承認待ち」を足したもの
 * （「確かめたいことがある」のままにしない）。
 */
export type FaceKey = StateKey | "awaiting";
export const AWAITING_LABEL = "承認待ち";

/** 聞き取った言葉が無いときの、呼びかけの案内 */
export const CALL_HINT = "「んだ、Claude」と声をかけてください";

/** 明細の各行の進み具合 */
export type ItemStatus = "ok" | "working" | "ask" | "pending";

export type MonitorState = {
  label: string;
  /** 吹き出しの上段。null なら呼びかけの案内を出す */
  heard: string | null;
  /** 聞き取りの途中か（末尾にカーソルを点滅させる） */
  heardPartial?: boolean;
  /** 吹き出しの下段（今していること） */
  doing: string;
  /** 明細の各行の状態。空なら明細はまだ無い */
  items: ItemStatus[];
  asks: string[];
  resolved: string[];
};

export const STATES: Record<StateKey, MonitorState> = {
  idle: {
    label: "待機中",
    heard: null,
    doing: "待っています。手は整備のままで。",
    items: [],
    asks: [],
    resolved: [],
  },
  listening: {
    label: "聞いている",
    heard: "タイヤ4本、組替とバランスだ。廃タイヤも",
    heardPartial: true,
    doing: "聞いています",
    items: [],
    asks: [],
    resolved: [],
  },
  thinking: {
    label: "考え中",
    heard: HEARD,
    doing: "明細に分けています",
    items: [],
    asks: [],
    resolved: [],
  },
  drafting: {
    label: "請求書を作っている",
    heard: HEARD,
    doing: "請求書を作っています",
    items: ["ok", "ok", "working", "pending"],
    asks: [],
    resolved: [],
  },
  asking: {
    label: "確かめたいことがある",
    heard: HEARD,
    doing: "バルブは何本ですか",
    items: ["ok", "ok", "ok", "ask"],
    asks: ["バルブは何本ですか"],
    resolved: [],
  },
  done: {
    label: "承認した",
    heard: "4本",
    doing: "承認しました。事務所に送ります",
    items: ["ok", "ok", "ok", "ok"],
    asks: [],
    resolved: ["エアバルブ交換 4本（答えてもらった）"],
  },
};

export function toStateKey(v: string | string[] | undefined): StateKey {
  const s = Array.isArray(v) ? v[0] : v;
  return (STATE_KEYS as readonly string[]).includes(s ?? "") ? (s as StateKey) : "idle";
}
