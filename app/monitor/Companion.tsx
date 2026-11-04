// 相棒のキャラクター。整備服（つなぎ）とキャップのタコ。
// Clawd と見分けがつくよう、ピクセル絵にせず曲線で描き、色は藤色、形は丸い頭と 8 本の腕にする。

import styles from "./monitor.module.css";
import type { FaceKey } from "./states";

const BODY = "#8f78d8";
const BODY_LIGHT = "#c3b4f0";
const SUIT = "#244a7c";
const SUIT_DARK = "#18345a";
const INK = "#2a2147";

type Pose = "down" | "up" | "ear" | "front" | "offer";

// 腕（袖から出る 2 本）の形。左は x を 400 から引いて右と対にする。
const ARM_R: Record<Pose, string> = {
  down: "M285 282 C320 302 330 342 320 382 C315 397 330 402 338 394",
  up: "M285 282 C322 262 342 212 332 172 C328 157 342 150 350 158",
  ear: "M285 282 C332 272 348 232 338 197 C333 182 320 180 314 188",
  front: "M285 287 C302 322 272 342 242 334",
  offer: "M285 282 C322 292 346 302 362 287 C370 280 364 270 354 274",
};

function mirror(d: string): string {
  // 数値の組 (x y) の x だけを左右反転する
  return d.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, (_, x, y) => `${400 - Number(x)} ${y}`);
}

const POSE: Record<FaceKey, { left: Pose; right: Pose }> = {
  idle: { left: "down", right: "down" },
  listening: { left: "down", right: "ear" },
  thinking: { left: "front", right: "down" },
  drafting: { left: "front", right: "front" },
  asking: { left: "down", right: "offer" },
  done: { left: "up", right: "up" },
  // 承認待ち: できた請求書を抱えて、耳を傾けて承認の言葉を待つ
  awaiting: { left: "front", right: "ear" },
};

// 目の中の黒目の向き
const LOOK: Record<FaceKey, [number, number]> = {
  idle: [0, 4],
  listening: [9, 0],
  thinking: [-8, -11],
  drafting: [0, 12],
  asking: [0, 0],
  done: [0, 0],
  awaiting: [7, 0],
};

function Eye({ cx, state }: { cx: number; state: FaceKey }) {
  const cy = 175;
  if (state === "done") {
    return <path d={`M${cx - 24} ${cy + 6} Q${cx} ${cy - 22} ${cx + 24} ${cy + 6}`} stroke={INK} strokeWidth={9} fill="none" strokeLinecap="round" />;
  }
  const [dx, dy] = LOOK[state];
  const big = state === "asking" || state === "listening";
  return (
    <g>
      <ellipse cx={cx} cy={cy} rx={big ? 31 : 28} ry={big ? 36 : 32} fill="#fff" stroke={INK} strokeWidth={4} />
      <circle cx={cx + dx} cy={cy + dy} r={big ? 16 : 14} fill={INK} />
      <circle cx={cx + dx + 5} cy={cy + dy - 6} r={5} fill="#fff" />
      {state === "idle" && (
        // まぶたを半分下ろして、落ち着いて待っている顔にする
        <path d={`M${cx - 30} ${cy} A30 34 0 0 1 ${cx + 30} ${cy} Z`} fill={BODY} stroke={INK} strokeWidth={4} />
      )}
    </g>
  );
}

function Mouth({ state }: { state: FaceKey }) {
  switch (state) {
    case "listening":
      return <ellipse cx={200} cy={232} rx={9} ry={11} fill={INK} />;
    case "thinking":
      return <path d="M182 232 Q191 225 200 232 Q209 239 218 232" stroke={INK} strokeWidth={6} fill="none" strokeLinecap="round" />;
    case "drafting":
      return <path d="M184 228 Q200 238 216 228" stroke={INK} strokeWidth={6} fill="none" strokeLinecap="round" />;
    case "asking":
      return <ellipse cx={200} cy={234} rx={13} ry={15} fill={INK} />;
    case "done":
      return (
        <g>
          <path d="M168 220 Q200 262 232 220 Z" fill={INK} />
          <path d="M184 238 Q200 252 216 238 Q200 232 184 238 Z" fill="#f28fb0" />
        </g>
      );
    default:
      return <path d="M180 226 Q200 242 220 226" stroke={INK} strokeWidth={6} fill="none" strokeLinecap="round" />;
  }
}

function Wrench({ x, y, rotate }: { x: number; y: number; rotate: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate})`}>
      <rect x={-7} y={0} width={14} height={70} rx={6} fill="#9aa6b5" stroke={INK} strokeWidth={3} />
      <path d="M-20 -6 A20 20 0 1 0 20 -6 L8 -6 L8 -22 L-8 -22 L-8 -6 Z" fill="#9aa6b5" stroke={INK} strokeWidth={3} />
    </g>
  );
}

export default function Companion({ state }: { state: FaceKey }) {
  const pose = POSE[state];
  const arm = (side: "left" | "right") => {
    const d = ARM_R[pose[side]];
    return side === "right" ? d : mirror(d);
  };

  return (
    <svg viewBox="0 0 400 500" className={`${styles.companion} ${styles[`c_${state}`]}`} role="img" aria-label={`相棒（${state}）`}>
      {/* 床の影 */}
      <ellipse cx={200} cy={482} rx={150} ry={12} fill="#000" opacity={0.08} />

      <g className={styles.whole}>
        {/* 裾から出る 4 本の腕 */}
        <g stroke={BODY} strokeWidth={28} fill="none" strokeLinecap="round">
          <path d="M135 405 C122 440 96 452 82 436" />
          <path d="M178 412 C176 448 160 468 142 462" />
          <path d="M222 412 C224 448 240 468 258 462" />
          <path d="M265 405 C278 440 304 452 318 436" />
        </g>
        <g fill={BODY_LIGHT}>
          <circle cx={98} cy={444} r={5} />
          <circle cx={158} cy={460} r={5} />
          <circle cx={242} cy={460} r={5} />
          <circle cx={302} cy={444} r={5} />
        </g>

        {/* つなぎ */}
        <path d="M112 270 Q112 250 142 248 L258 248 Q288 250 288 270 L300 408 Q300 420 288 420 L112 420 Q100 420 100 408 Z" fill={SUIT} stroke={INK} strokeWidth={4} />
        <path d="M160 250 L200 290 L240 250 Z" fill={SUIT_DARK} />
        <line x1={200} y1={290} x2={200} y2={408} stroke="#c9d3e3" strokeWidth={4} strokeDasharray="6 5" />
        <rect x={104} y={352} width={192} height={14} fill={SUIT_DARK} />
        <rect x={130} y={300} width={46} height={34} rx={4} fill="none" stroke="#c9d3e3" strokeWidth={3} />
        <line x1={146} y1={292} x2={146} y2={314} stroke="#f2c230" strokeWidth={5} strokeLinecap="round" />
        <rect x={210} y={296} width={76} height={30} rx={6} fill="#fff" />
        <text x={248} y={317} textAnchor="middle" fontSize={14} fontWeight={800} fill={SUIT}>んだびょん</text>

        {/* 持ち物（腕より奥） */}
        {(state === "drafting" || state === "thinking" || state === "awaiting") && (
          <g transform="rotate(-6 200 340)">
            <rect x={146} y={296} width={108} height={86} rx={8} fill="#a77b4f" stroke={INK} strokeWidth={4} />
            <rect x={156} y={306} width={88} height={68} fill="#fff" />
            <rect x={182} y={290} width={36} height={14} rx={4} fill="#9aa6b5" stroke={INK} strokeWidth={3} />
            <g stroke="#9aa6b5" strokeWidth={4} strokeLinecap="round">
              <line x1={166} y1={322} x2={232} y2={322} />
              <line x1={166} y1={338} x2={222} y2={338} />
              <line x1={166} y1={354} x2={210} y2={354} className={state === "drafting" ? styles.lineGrow : undefined} />
            </g>
          </g>
        )}

        {/* 袖から出る 2 本の腕 */}
        <g stroke={BODY} strokeWidth={26} fill="none" strokeLinecap="round">
          <path d={arm("left")} className={styles.armLeft} />
          <path d={arm("right")} className={state === "drafting" ? styles.scribble : styles.armRight} />
        </g>
        {/* 袖口 */}
        <g stroke={SUIT} strokeWidth={36} strokeLinecap="round">
          <line x1={128} y1={262} x2={114} y2={284} />
          <line x1={272} y1={262} x2={286} y2={284} />
        </g>
        {state === "drafting" && (
          <g className={styles.scribble}>
            <line x1={236} y1={336} x2={212} y2={360} stroke="#f2c230" strokeWidth={8} strokeLinecap="round" />
          </g>
        )}
        {state === "idle" && <Wrench x={338} y={394} rotate={-30} />}
        {state === "done" && <Wrench x={350} y={150} rotate={-20} />}

        {/* 頭 */}
        <g className={styles.head}>
          <ellipse cx={200} cy={160} rx={136} ry={124} fill={BODY} stroke={INK} strokeWidth={4} />
          <ellipse cx={140} cy={120} rx={30} ry={18} fill="#fff" opacity={0.35} transform="rotate(-25 140 120)" />
          {/* キャップ */}
          <path d="M84 112 C86 50 140 28 200 28 C260 28 314 50 316 112 Z" fill={SUIT} stroke={INK} strokeWidth={4} />
          <ellipse cx={200} cy={114} rx={150} ry={17} fill={SUIT_DARK} stroke={INK} strokeWidth={4} />
          {/* キャップの記章（Claude の色へのオマージュ。差し色の小さな面積だけに使う） */}
          <circle cx={200} cy={74} r={22} fill="#d97757" stroke={INK} strokeWidth={3} />
          <text x={200} y={84} textAnchor="middle" fontSize={26} fontWeight={800} fill="#fff">ん</text>

          {state === "asking" && (
            <g stroke={INK} strokeWidth={6} fill="none" strokeLinecap="round">
              <path d="M126 132 Q150 120 172 130" />
              <path d="M228 130 Q250 120 274 132" />
            </g>
          )}
          <g className={state === "done" ? undefined : styles.blink}>
            <Eye cx={150} state={state} />
            <Eye cx={250} state={state} />
          </g>
          <ellipse cx={116} cy={214} rx={18} ry={10} fill="#f28fb0" opacity={0.7} />
          <ellipse cx={284} cy={214} rx={18} ry={10} fill="#f28fb0" opacity={0.7} />
          <Mouth state={state} />
        </g>
      </g>

      {/* 状態ごとの記号（体の外） */}
      {(state === "listening" || state === "awaiting") && (
        <g stroke={state === "awaiting" ? "#0f7f65" : "#1f6fd1"} strokeWidth={7} fill="none" strokeLinecap="round">
          <path d="M358 150 Q372 170 358 190" className={styles.wave1} />
          <path d="M374 132 Q398 170 374 208" className={styles.wave2} />
        </g>
      )}
      {state === "thinking" && (
        <g fill="#6b4fc9">
          <circle cx={318} cy={44} r={10} className={styles.dot1} />
          <circle cx={346} cy={30} r={13} className={styles.dot2} />
          <circle cx={380} cy={20} r={16} className={styles.dot3} />
        </g>
      )}
      {state === "asking" && (
        <text x={352} y={84} textAnchor="middle" fontSize={96} fontWeight={900} fill="#e0a100" stroke={INK} strokeWidth={4} className={styles.question}>?</text>
      )}
      {state === "done" && (
        <g fill="#f2c230" stroke={INK} strokeWidth={3}>
          <path d="M60 60 l8 18 l18 8 l-18 8 l-8 18 l-8 -18 l-18 -8 l18 -8 Z" className={styles.spark1} />
          <path d="M40 220 l5 12 l12 5 l-12 5 l-5 12 l-5 -12 l-12 -5 l12 -5 Z" className={styles.spark2} />
          <path d="M370 250 l6 14 l14 6 l-14 6 l-6 14 l-6 -14 l-14 -6 l14 -6 Z" className={styles.spark3} />
        </g>
      )}
    </svg>
  );
}
