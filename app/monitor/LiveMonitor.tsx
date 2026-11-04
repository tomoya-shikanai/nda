"use client";

// 工場のモニター（本番の配線）。2 秒ごとに /api/session/current の MonitorView を読んで出す。
// 金額は view の値だけを出す（計算しない）。読めないときは前の表示のまま「つながっていません」を出す。
// states.ts は node:fs を使う store を import するので、ここでは型だけを使い、文言は page から受け取る。

import { useEffect, useRef, useState } from "react";
import { type MonitorLine, type MonitorView, toMonitorView, yenText } from "../../lib/session/view";
import Companion from "./Companion";
import styles from "./monitor.module.css";
import type { StateKey } from "./states";

const POLL_MS = 2000;

function isView(v: unknown, labels: Record<StateKey, string>): v is MonitorView {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.state === "string" &&
    Object.prototype.hasOwnProperty.call(labels, o.state) &&
    typeof o.say === "string" &&
    Array.isArray(o.lines) &&
    Array.isArray(o.questions) &&
    typeof o.confirmationCount === "number" &&
    typeof o.credit === "string"
  );
}

function lineState(l: MonitorLine): string {
  const parts: string[] = [];
  if (l.status === "ask") parts.push("確認待ち");
  if (l.answered.length > 0) parts.push("答えてもらった");
  return parts.length > 0 ? parts.join("・") : "入れた";
}

export default function LiveMonitor({ labels, hint }: { labels: Record<StateKey, string>; hint: string }) {
  const [view, setView] = useState<MonitorView>(() => toMonitorView(null));
  const [offline, setOffline] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const spokenRef = useRef<string | null>(null);

  // say が前と変わったときだけ声を鳴らす（W5）。VOICEVOX が動いていない（503）・自動再生の制限で鳴らないときは、文字だけで続ける。
  // 読み込む前の仮の表示（toMonitorView(null)）では鳴らさない。
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!loaded || spokenRef.current === view.say) return;
    spokenRef.current = view.say;
    const a = audioRef.current;
    if (!a) return;
    a.src = `/api/session/current/speech?t=${Date.now()}`;
    void a.play().catch(() => {});
  }, [loaded, view.say]);

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

  const key = view.state;
  const asksOn = view.confirmationCount > 0 || view.questions.length > 0;
  const okCount = view.lines.filter((l) => l.status === "ok").length;
  const total = yenText(view.total);

  return (
    <main className={`${styles.screen} ${styles[`s_${key}`]}`}>
      <header className={styles.top}>
        <div className={styles.brand}>
          んだ <span>nDa</span>
        </div>
        <div className={styles.status}>
          <span className={styles.lamp} />
          {labels[key]}
        </div>
      </header>

      <section className={styles.body}>
        <div className={styles.stage}>
          <Companion state={key} />
        </div>

        <div className={styles.right}>
          <div className={styles.bubble}>
            {view.heard === null ? (
              <p className={styles.hint}>{hint}</p>
            ) : (
              <>
                <p className={styles.small}>聞き取った言葉</p>
                <p className={styles.heard}>「{view.heard}」</p>
              </>
            )}
            <p className={styles.doing}>{view.say}</p>
          </div>

          <div className={`${styles.asks} ${asksOn ? styles.asksOn : ""}`}>
            <h2>確認事項 {view.confirmationCount > 0 && <b>{view.confirmationCount}</b>}</h2>
            <ul>
              {view.questions.length === 0 && !view.approved && <li className={styles.none}>ありません</li>}
              {view.questions.map((q, i) => (
                <li key={i} className={styles.ask}>
                  {q}
                </li>
              ))}
              {view.approved && <li className={styles.resolved}>✓ 承認済み</li>}
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
              <p className={styles.none}>まだありません</p>
            ) : (
              <ul>
                {view.lines.map((l, i) => {
                  const ask = l.status === "ask";
                  return (
                    <li key={i} className={`${styles.item} ${ask ? styles.i_ask : styles.i_ok}`}>
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
                <li className={styles.item}>
                  <span className={styles.icon} />
                  <span className={styles.itemName}>合計</span>
                  {total === null ? (
                    <span className={styles.itemState}>確認が済むまで出しません</span>
                  ) : (
                    <span className={styles.itemPrice}>{total}</span>
                  )}
                </li>
              </ul>
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
