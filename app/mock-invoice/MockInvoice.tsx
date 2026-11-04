"use client";

import { useEffect, useState } from "react";
import { ANSWERED_VALVE_QTY, CUSTOMER, ITEMS, TAX_RATE, yen } from "../_demo/tire-change";
import styles from "./invoice.module.css";

// 模擬画面では、確認事項に答えてもらった後の数で入れる
const ROWS = ITEMS.map((it) => ({ ...it, qty: it.qty ?? ANSWERED_VALVE_QTY }));
const STEP_MS = 1400;

export default function MockInvoice({ initialStep, autoPlay }: { initialStep: number; autoPlay: boolean }) {
  const [shown, setShown] = useState(initialStep);
  const [started, setStarted] = useState(autoPlay);
  const [confirmed, setConfirmed] = useState(false);

  // 再生中かは、始めたかと残りの行から決める（止める処理を持たない）
  const playing = started && shown < ROWS.length;

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setShown((n) => n + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, shown]);

  const rows = ROWS.slice(0, shown);
  const subtotal = rows.reduce((a, r) => a + r.price * r.qty, 0);
  const tax = Math.floor(subtotal * TAX_RATE);
  const finished = shown >= ROWS.length;

  const start = () => {
    setConfirmed(false);
    setShown(0);
    setStarted(true);
  };

  return (
    <div className={styles.page}>
      <div className={styles.note}>
        <strong>模擬画面</strong>（実際は市販の整備ソフトに入力）
        <span className={styles.noteSpacer} />
        <span className={styles.agent}>
          {playing ? `相棒が入力しています… ${shown}／${ROWS.length} 行` : finished ? "相棒の入力は終わりました" : "相棒の入力を待っています"}
        </span>
        <button type="button" className={styles.play} onClick={start} disabled={playing}>
          {shown === 0 ? "▶ 再生" : "↺ 最初から"}
        </button>
      </div>

      <div className={styles.window}>
        <div className={styles.titlebar}>請求書の入力</div>

        <div className={styles.form}>
          <div className={styles.fields}>
            <label>
              伝票番号<input readOnly value="0001" />
            </label>
            <label>
              日付<input readOnly value="2026/11/04" />
            </label>
            <label className={styles.wide}>
              お客様<input readOnly value={CUSTOMER.name} />
            </label>
            <label className={styles.wide}>
              車両<input readOnly value={CUSTOMER.vehicle} />
            </label>
            <label className={styles.wide}>
              作業内容<input readOnly value={CUSTOMER.work} />
            </label>
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.no}>No.</th>
                <th>品目</th>
                <th className={styles.num}>数量</th>
                <th className={styles.unit}>単位</th>
                <th className={styles.num}>単価</th>
                <th className={styles.num}>金額</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 5 }, (_, i) => {
                const r = rows[i];
                const fresh = started && i === shown - 1;
                return (
                  <tr key={i} className={fresh ? styles.fresh : undefined}>
                    <td className={styles.no}>{i + 1}</td>
                    <td>{r?.name}</td>
                    <td className={styles.num}>{r?.qty}</td>
                    <td className={styles.unit}>{r?.unit}</td>
                    <td className={styles.num}>{r && yen(r.price)}</td>
                    <td className={styles.num}>{r && yen(r.price * r.qty)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className={styles.bottom}>
            <div className={styles.memo}>
              備考
              <textarea readOnly value="" />
            </div>
            <dl className={styles.totals}>
              <dt>小計</dt>
              <dd>{yen(subtotal)}</dd>
              <dt>消費税（10%）</dt>
              <dd>{yen(tax)}</dd>
              <dt className={styles.grand}>合計</dt>
              <dd className={styles.grand}>{yen(subtotal + tax)}</dd>
            </dl>
          </div>

          <div className={styles.actions}>
            {finished && !confirmed && <div className={styles.human}>最後の確定は人が押します</div>}
            {confirmed && <div className={styles.done}>確定しました（模擬）</div>}
            <button type="button" className={styles.secondary} disabled>
              一時保存
            </button>
            <button
              type="button"
              className={`${styles.confirm} ${finished && !confirmed ? styles.waiting : ""}`}
              disabled={!finished || playing || confirmed}
              onClick={() => setConfirmed(true)}
            >
              確定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
