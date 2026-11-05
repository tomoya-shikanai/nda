"use client";

// 工場のモニター（本番の配線）。2 秒ごとに /api/session/current の MonitorView を読んで出す。
// 金額は view の値だけを出す（計算しない）。読めないときは前の表示のまま「つながっていません」を出す。
// states.ts は node:fs を使う store を import するので、ここでは型だけを使い、文言は page から受け取る。
// 1920×1080 で明細の合計が必ず見えるよう、吹き出しと確認事項の帯の高さに上限を置き、明細の行は詰めるかスクロールし、
// 合計の行は明細の欄の下に固定する。

import { useEffect, useRef, useState } from "react";
import type { PublicLedger } from "../../lib/ledger/lookup";
import { type MonitorLine, type MonitorView, toMonitorView, yenText } from "../../lib/session/view";
import Companion from "./Companion";
import styles from "./monitor.module.css";
import type { FaceKey, LabelKey } from "./states";

/** 承認の後の状態は、試作の 6 つの表情を借りる（states.ts の FACE_OF と同じ。states.ts は node を使う store を読むので写す）。 */
const AFTER_FACE: Record<string, FaceKey> = { sending: "drafting", sent: "drafting", entered: "done", stopped: "asking" };

const POLL_MS = 2000;
/** これより行が多ければ明細を詰める。 */
const DENSE_LINES = 4;

function isView(v: unknown, labels: Record<LabelKey, string>): v is MonitorView {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.state === "string" &&
    Object.prototype.hasOwnProperty.call(labels, o.state) &&
    typeof o.say === "string" &&
    typeof o.sayId === "string" &&
    typeof o.awaitingApproval === "boolean" &&
    Array.isArray(o.lines) &&
    Array.isArray(o.questions) &&
    typeof o.credit === "string"
  );
}

function isLedger(v: unknown): v is PublicLedger {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.items) &&
    o.items.every((e) => typeof e?.item === "string" && Array.isArray(e?.aliases)) &&
    Array.isArray(o.ambiguous) &&
    o.ambiguous.every((a) => typeof a?.word === "string" && Array.isArray(a?.choices))
  );
}

/** 言える作業の一覧（明細がまだ無いときに出す）。料金表の品目名と別名、言い換えの言葉。 */
function Sayable({ ledger }: { ledger: PublicLedger }) {
  if (ledger.items.length === 0) return <p className={styles.none}>まだありません</p>;
  return (
    <div className={styles.sayable}>
      <p className={styles.small}>言える作業</p>
      <ul>
        {ledger.items.map((e) => (
          <li key={e.item}>
            <b>{e.item}</b>
            {e.aliases.length > 0 && <span>（{e.aliases.join("・")}）</span>}
          </li>
        ))}
        {ledger.ambiguous.map((a) => (
          <li key={a.word}>
            <b>{a.word}</b>
            <span>（{a.choices.join("か")}かを聞きます）</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function lineState(l: MonitorLine): string {
  const parts: string[] = [];
  if (l.status === "ask") parts.push("確認待ち");
  if (l.answered.length > 0) parts.push("答えてもらった");
  return parts.length > 0 ? parts.join("・") : "入れた";
}

/** 台詞の長さで文字の大きさを選ぶ（吹き出しの高さを超えないように）。 */
function sayClass(say: string): string {
  if (say.length <= 30) return styles.doing;
  if (say.length <= 40) return `${styles.doing} ${styles.doingLong}`;
  return `${styles.doing} ${styles.doingLonger}`;
}

export default function LiveMonitor({ labels, hint }: { labels: Record<LabelKey, string>; hint: string }) {
  const [view, setView] = useState<MonitorView>(() => toMonitorView(null));
  const [offline, setOffline] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const spokenRef = useRef<string | null>(null);
  const linesRef = useRef<HTMLUListElement>(null);
  const [ledger, setLedger] = useState<PublicLedger | null>(null);

  // 言える作業の一覧は 1 回だけ読む（読めなければ「まだありません」のまま）
  useEffect(() => {
    let alive = true;
    void fetch("/api/ledger", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        if (alive && isLedger(j)) setLedger(j);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 台詞の通し番号が変わったときだけ声を鳴らす（同じ台詞でも、答えが読めなかったときは言い直す）。
  // VOICEVOX が動いていない（503）・自動再生の制限で鳴らないときは、文字だけで続ける。
  // 読み込む前の仮の表示（toMonitorView(null)）では鳴らさない。
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!loaded || spokenRef.current === view.sayId) return;
    spokenRef.current = view.sayId;
    const a = audioRef.current;
    if (!a) return;
    a.src = `/api/session/current/speech?t=${Date.now()}`;
    void a.play().catch(() => {});
  }, [loaded, view.sayId]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/session/current", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();
        if (!isView(json, labels)) throw new Error("形が違う");
        if (!alive) return;
        setView(json);
        setLoaded(true);
        setOffline(false);
      } catch {
        if (alive) setOffline(true);
      }
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [labels]);

  // 明細が欄に収まらないときは、最初の確認待ちの行がちょうど見える所までだけスクロールする
  useEffect(() => {
    const ul = linesRef.current;
    if (!ul) return;
    const ask = ul.querySelector<HTMLElement>("[data-ask]");
    const bottom = ask ? ask.offsetTop + ask.offsetHeight : 0;
    ul.scrollTop = Math.max(0, bottom - ul.clientHeight);
  }, [view.lines]);

  const face: FaceKey = view.awaitingApproval ? "awaiting" : (AFTER_FACE[view.state] ?? (view.state as FaceKey));
  const label = labels[view.awaitingApproval ? "awaiting" : view.state];
  const asks = view.questions.length;
  const okCount = view.lines.filter((l) => l.status === "ok").length;
  const total = yenText(view.total);
  const dense = view.lines.length > DENSE_LINES;

  return (
    <main className={`${styles.screen} ${styles[`s_${face}`]}`}>
      <header className={styles.top}>
        <div className={styles.brand}>
          んだ <span>nDa</span>
        </div>
        <div className={styles.customer}>
          {view.customer ?? "お客様: 未指定"}
        </div>
        <div className={styles.status}>
          <span className={styles.lamp} />
          {label}
        </div>
      </header>

      <section className={styles.body}>
        <div className={styles.stage}>
          <Companion state={face} />
        </div>

        <div className={styles.right}>
          <div className={styles.bubble}>
            {view.heard === null ? (
              <p className={styles.hint}>{hint}</p>
            ) : (
              <>
                <p className={styles.small}>聞き取った言葉</p>
                {/* 長い文字起こしは最新の 2 行だけを見せる（頭は欄の上で切れる） */}
                <div className={styles.heardBox}>
                  <p className={styles.heard}>「{view.heard}」</p>
                </div>
              </>
            )}
            <p className={sayClass(view.say)}>{view.say}</p>
          </div>

          <div className={`${styles.asks} ${asks > 0 ? styles.asksOn : ""}`}>
            <h2>確認事項 {asks > 0 && <b>{asks}</b>}</h2>
            <ul>
              {asks === 0 && !view.approved && <li className={styles.none}>ありません</li>}
              {/* 帯は 1 行だけ（今聞いている質問と、残りの数）。高さを変えず、明細の合計を押し出さない */}
              {asks > 0 && (
                <li className={styles.askRow}>
                  <span className={styles.ask}>{view.questions[0]}</span>
                  {asks > 1 && <span className={styles.more}>ほか {asks - 1} 問</span>}
                </li>
              )}
              {view.approved && (
                <li className={styles.resolved}>
                  ✓ 承認済み{view.office && <span className={styles.more}>{view.office}</span>}
                </li>
              )}
            </ul>
          </div>

          <div className={styles.panel}>
            <h2>
              明細
              {view.lines.length > 0 && (
                <span className={styles.count}>
                  {okCount}／{view.lines.length} 行
                </span>
              )}
            </h2>
            {view.lines.length === 0 ? (
              ledger === null ? (
                <p className={styles.none}>まだありません</p>
              ) : (
                <Sayable ledger={ledger} />
              )
            ) : (
              <>
                <ul ref={linesRef} className={`${styles.lines} ${dense ? styles.dense : ""}`}>
                  {view.lines.map((l, i) => {
                    const ask = l.status === "ask";
                    return (
                      <li key={i} data-ask={ask ? "" : undefined} className={`${styles.item} ${ask ? styles.i_ask : styles.i_ok}`}>
                        <span className={styles.icon}>{ask ? "?" : "✓"}</span>
                        <span className={styles.itemName}>
                          {l.item}
                          {l.qty !== null && ` ×${l.qty}${l.unit ?? ""}`}
                        </span>
                        <span className={styles.itemState}>{lineState(l)}</span>
                        <span className={styles.itemPrice}>{yenText(l.amount) ?? "値段？"}</span>
                      </li>
                    );
                  })}
                </ul>
                <div className={`${styles.item} ${styles.totalRow}`}>
                  <span className={styles.icon} />
                  <span className={styles.itemName}>合計</span>
                  {total === null ? (
                    <span className={styles.itemState}>確認が済むまで出しません</span>
                  ) : (
                    <span className={styles.itemPrice}>{total}</span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <audio ref={audioRef} preload="none" />

      <footer className={styles.foot}>
        {view.credit}
        {offline && <span className={styles.offline}>つながっていません</span>}
      </footer>
    </main>
  );
}
