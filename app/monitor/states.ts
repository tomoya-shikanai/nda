// モニターの 6 つの状態と、試作（?mock=1）で見せる架空の中身。状態の並びは lib/session/store.ts が正。

import { SESSION_STATES, type SessionStatus } from "../../lib/session/store";
import { HEARD } from "../_demo/tire-change";

export const STATE_KEYS = SESSION_STATES;
export type StateKey = SessionStatus;

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
    label: "終わった",
    heard: "4本",
    doing: "4 行入れました。発行は人が押してください",
    items: ["ok", "ok", "ok", "ok"],
    asks: [],
    resolved: ["エアバルブ交換 4本（答えてもらった）"],
  },
};

export function toStateKey(v: string | string[] | undefined): StateKey {
  const s = Array.isArray(v) ? v[0] : v;
  return (STATE_KEYS as readonly string[]).includes(s ?? "") ? (s as StateKey) : "idle";
}
