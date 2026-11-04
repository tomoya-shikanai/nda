// 工場のモニター（1920×1080、数メートル離れて見る）。
// /monitor は作業の状態（/api/session/current）を 2 秒ごとに読んで出す（LiveMonitor）。
// /monitor?mock=1 は架空のタイヤ交換の模擬。?mock=1&state=idle|listening|thinking|drafting|asking|done で状態を切り替える。
// ?nav=0 で切り替えの帯を隠す。

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { VOICE_CREDIT } from "../../lib/session/view";
import { ANSWERED_VALVE_QTY, ITEMS, yen } from "../_demo/tire-change";
import Companion from "./Companion";
import LiveMonitor from "./LiveMonitor";
import styles from "./monitor.module.css";
import { AWAITING_LABEL, CALL_HINT, type FaceKey, STATE_KEYS, STATES, toStateKey, type ItemStatus } from "./states";

export const metadata: Metadata = { title: "んだ — 工場のモニター" };

const MARK: Record<ItemStatus, { icon: string; text: string }> = {
  ok: { icon: "✓", text: "入れた" },
  working: { icon: "…", text: "作っている" },
  ask: { icon: "?", text: "確認待ち" },
  pending: { icon: "・", text: "まだ" },
};

const LABELS = {
  ...Object.fromEntries(STATE_KEYS.map((k) => [k, STATES[k].label])),
  awaiting: AWAITING_LABEL,
} as Record<FaceKey, string>;

export default function MonitorPage({ searchParams }: PageProps<"/monitor">) {
  return (
    <Suspense fallback={null}>
      <Monitor searchParams={searchParams} />
    </Suspense>
  );
}

async function Monitor({ searchParams }: Pick<PageProps<"/monitor">, "searchParams">) {
  const params = await searchParams;
  if (params.mock !== "1") return <LiveMonitor labels={LABELS} hint={CALL_HINT} />;
  return <MockMonitor state={params.state} showNav={params.nav !== "0"} />;
}

function MockMonitor({ state, showNav }: { state: string | string[] | undefined; showNav: boolean }) {
  const key = toStateKey(state);
  const s = STATES[key];

  return (
    <main className={`${styles.screen} ${styles[`s_${key}`]} ${showNav ? styles.withNav : ""}`}>
      <header className={styles.top}>
        <div className={styles.brand}>
          んだ <span>nDa</span>
        </div>
        <div className={styles.status}>
          <span className={styles.lamp} />
          {s.label}
        </div>
      </header>

      <section className={styles.body}>
        <div className={styles.stage}>
          <Companion state={key} />
        </div>

        <div className={styles.right}>
          <div className={styles.bubble}>
            {s.heard === null ? (
              <p className={styles.hint}>{CALL_HINT}</p>
            ) : (
              <>
                <p className={styles.small}>聞き取った言葉</p>
                <p className={styles.heard}>
                  「{s.heard}
                  {s.heardPartial ? <span className={styles.caret} /> : "」"}
                </p>
              </>
            )}
            <p className={styles.doing}>{s.doing}</p>
          </div>

          <div className={`${styles.asks} ${s.asks.length > 0 ? styles.asksOn : ""}`}>
            <h2>
              確認事項 {s.asks.length > 0 && <b>{s.asks.length}</b>}
            </h2>
            <ul>
              {s.asks.length === 0 && s.resolved.length === 0 && <li className={styles.none}>ありません</li>}
              {s.asks.map((a) => (
                <li key={a} className={styles.ask}>
                  {a}
                </li>
              ))}
              {s.resolved.map((r) => (
                <li key={r} className={styles.resolved}>
                  ✓ {r}
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.panel}>
            <h2>
              明細
              {s.items.length > 0 && (
                <span className={styles.count}>
                  {s.items.filter((i) => i === "ok").length}／{ITEMS.length} 行
                </span>
              )}
            </h2>
            {s.items.length === 0 ? (
              <p className={styles.none}>{key === "thinking" ? "分けています…" : "まだありません"}</p>
            ) : (
              <ul>
                {ITEMS.map((it, i) => {
                  const st = s.items[i] ?? "pending";
                  // 数の分からない行は、答えてもらうまで数量も金額も出さない
                  const qty = it.qty ?? (key === "done" ? ANSWERED_VALVE_QTY : null);
                  return (
                    <li key={it.name} className={`${styles.item} ${styles[`i_${st}`]}`}>
                      <span className={styles.icon}>{MARK[st].icon}</span>
                      <span className={styles.itemName}>
                        {it.name}
                        {qty !== null && ` ×${qty}${it.unit}`}
                      </span>
                      <span className={styles.itemState}>{MARK[st].text}</span>
                      <span className={styles.itemPrice}>{qty === null ? "値段？" : yen(it.price * qty)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>

      <footer className={styles.foot}>試作・架空のデータ　{VOICE_CREDIT}</footer>

      {showNav && (
        <nav className={styles.nav}>
          {STATE_KEYS.map((k) => (
            <Link key={k} href={`/monitor?mock=1&state=${k}`} className={k === key ? styles.navOn : undefined}>
              {STATES[k].label}
            </Link>
          ))}
        </nav>
      )}
    </main>
  );
}
