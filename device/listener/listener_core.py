"""現場の聞き役の、音声を使わずに試せる部分（起動語の判定・録音の止め時・WAV と multipart の組み立て・デバイスの選び方・出来事の記録）。
標準ライブラリだけを使う（vosk・sounddevice を import しない）。
"""

from __future__ import annotations

import io
import json
import math
import os
import stat
import uuid
import wave
from array import array
from dataclasses import dataclass
from datetime import datetime

# 起動語。Vosk の grammar に渡す（docs/experiments.md の 2026-11-04 の行で決めた形）。
WAKE_WORDS = ("んだ", "クロード")
GRAMMAR = ["んだ クロード", "[unk]"]
# 両語の conf の下限（架空の読み上げ 5/5・誤検出 0/10 だった値。工場の騒音で確かめ直す）
DEFAULT_WAKE_CONF = 0.9

RATE = 16000
# 秒の足し算（0.1 を 50 回）の誤差で 1 塊遅れないための余裕
_EPS = 1e-9


def wake_conf(result: dict, words: tuple[str, ...] = WAKE_WORDS) -> float | None:
    """Vosk の最終結果（SetWords(True) の result）に、起動語の語が並びのとおり続けて出た所の conf（その所の語の最小）。

    続けて出た所が複数なら最大。出ていない・result が無い・形が違う語があるなら None。記録（起動語の conf の分布）と is_wake が使う。
    """
    items = result.get("result")
    if not isinstance(items, list):
        return None
    seq = []
    for it in items:
        if not isinstance(it, dict):
            return None
        w, c = it.get("word"), it.get("conf")
        if not isinstance(w, str) or not isinstance(c, (int, float)):
            return None
        seq.append((w, float(c)))
    n = len(words)
    best = None
    for i in range(len(seq) - n + 1):
        window = seq[i : i + n]
        if all(w == want for (w, _), want in zip(window, words)):
            c = min(c for _, c in window)
            best = c if best is None else max(best, c)
    return best


def is_wake(result: dict, words: tuple[str, ...] = WAKE_WORDS, min_conf: float = DEFAULT_WAKE_CONF) -> bool:
    """起動語の語が並びのとおり続けて出て、どの語も conf ≥ min_conf なら True（wake_conf ≥ min_conf）。

    並びの途中に別の語が入る・語が欠ける・conf が足りない・result が無いなら False（推測で起動しない）。
    例: 「なんだ、クローゼットか」→「んだ んだ クロード」(conf 0.65) は conf で落ちる。
    """
    c = wake_conf(result, words)
    return c is not None and c >= min_conf


def rms(pcm: bytes) -> float:
    """16bit 符号つき・リトルエンディアンの PCM の RMS。空なら 0。"""
    a = array("h")
    a.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if len(a) == 0:
        return 0.0
    return math.sqrt(sum(x * x for x in a) / len(a))


@dataclass
class Endpointer:
    """録音の止め時。声が出た後に無音が silence_sec 続くか、合わせて max_sec で止める。

    声が一度も出ないまま first_voice_sec 過ぎたら止めて、送らない（無音を STT に送らない）。
    feed は 1 塊ごとに呼び、止めるなら True を返す。止めた後の結果は spoke で見る。
    """

    silence_rms: float = 500.0
    silence_sec: float = 1.5
    max_sec: float = 30.0
    first_voice_sec: float = 5.0
    elapsed: float = 0.0
    quiet: float = 0.0
    spoke: bool = False

    def feed(self, level: float, sec: float) -> bool:
        self.elapsed += sec
        if level >= self.silence_rms:
            self.spoke = True
            self.quiet = 0.0
        else:
            self.quiet += sec
        if self.elapsed >= self.max_sec - _EPS:
            return True
        if self.spoke:
            return self.quiet >= self.silence_sec - _EPS
        return self.elapsed >= self.first_voice_sec - _EPS


def wav_bytes(pcm: bytes, rate: int = RATE) -> bytes:
    """16bit モノラルの PCM を WAV のバイト列にする（メモリの中だけ。ファイルに書かない）。"""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def beep_pcm(rate: int = RATE, freq: float = 880.0, sec: float = 0.15, volume: float = 0.3) -> bytes:
    """合図音（正弦波、端は 10ms で上げ下げしてプツッと鳴らさない）。16bit モノラルの PCM。"""
    n = int(rate * sec)
    ramp = max(1, int(rate * 0.01))
    a = array("h")
    for i in range(n):
        env = min(1.0, i / ramp, (n - 1 - i) / ramp)
        a.append(int(32767 * volume * env * math.sin(2 * math.pi * freq * i / rate)))
    return a.tobytes()


def multipart(fields: dict[str, str], file_field: str, filename: str, content_type: str, data: bytes) -> tuple[bytes, str]:
    """multipart/form-data の body と Content-Type。"""
    boundary = "nda-" + uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields.items():
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    out.write(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n".encode()
    )
    out.write(data)
    out.write(f"\r\n--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def pick_device(devices: list[dict], query: str | None, kind: str = "input") -> int | None:
    """デバイスの番号。kind は "input" か "output"。query が無ければ None（システムの既定）。

    名前の部分一致（大文字小文字を問わない）で、その向きのチャンネルがある最初のデバイス。
    当たりが無ければ ValueError（黙って既定のマイク・スピーカーに戻さない）。
    """
    if kind not in ("input", "output"):
        raise ValueError(f"kind は input か output: {kind!r}")
    if not query:
        return None
    q = query.lower()
    key = f"max_{kind}_channels"
    for i, d in enumerate(devices):
        if d.get(key, 0) > 0 and q in str(d.get("name", "")).lower():
            return i
    label = "入力" if kind == "input" else "出力"
    raise ValueError(f"{label}デバイスが見つからない: {query!r}（--list-devices で一覧）")


# --- 出来事の記録（docs/logging.md）。NDA_LOG_DIR の listener-YYYY-MM-DD.jsonl に 1 行ずつ足す ---
# 守り: 聞き取った言葉・録音・自由な文字列は記録しない。数・真偽・決まった種類名だけ。形が合わなければ捨てて log.invalid。

SEND_RESULTS = ("ok", "conflict", "rejected", "unreachable")
# 欄の形: "num"（有限の数）・"bool"・"int?"（整数か None）・決まった種類名の tuple
LISTENER_EVENTS: dict[str, dict[str, object]] = {
    # 起動語の語が並んで出た（通ったか・その conf・下限）
    "wake": {"conf": "num", "accepted": "bool", "minConf": "num"},
    # 録音（秒・声が出たか）
    "record": {"sec": "num", "spoke": "bool"},
    # 送信（ms・HTTP の状態コード。届かなければ None・結果の種類）
    "send": {"ms": "num", "status": "int?", "result": SEND_RESULTS},
}


def _ok(v: object, want: object) -> bool:
    if isinstance(want, tuple):
        return v in want
    if want == "bool":
        return isinstance(v, bool)
    if want == "num":
        return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
    if want == "int?":
        return v is None or (isinstance(v, int) and not isinstance(v, bool))
    return False


def _valid(kind: str, fields: dict) -> bool:
    """形が合うか。確かめの途中の例外（10**400 の OverflowError、dict でない fields など）は合わないとする。"""
    try:
        spec = LISTENER_EVENTS.get(kind)
        return spec is not None and set(fields) == set(spec) and all(_ok(fields[k], w) for k, w in spec.items())
    except Exception:  # noqa: BLE001
        return False


def log_event(kind: str, fields: dict, log_dir: str | None = None, now: datetime | None = None) -> None:
    """1 行足す。log_dir（無ければ NDA_LOG_DIR）が無ければ何もしない。形が合わなければ捨てて log.invalid。

    検証も書き込みも含めて、どんな例外でも投げない（記録の失敗で聞き役を止めない）。
    シンボリックリンクはたどらず（O_NOFOLLOW）、FIFO で止まらず（O_NONBLOCK）、開いた後に通常のファイルでなければ書かない。新規は 0600。
    """
    try:
        d = log_dir if log_dir is not None else os.environ.get("NDA_LOG_DIR")
        if not d:
            return
        now = now or datetime.now().astimezone()
        if _valid(kind, fields):
            line = {"t": now.isoformat(), "kind": kind, **fields}
        else:
            line = {"t": now.isoformat(), "kind": "log.invalid", "of": kind if isinstance(kind, str) and kind in LISTENER_EVENTS else "unknown"}
        data = (json.dumps(line, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, f"listener-{now.strftime('%Y-%m-%d')}.jsonl")
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        fd = os.open(path, flags, 0o600)
        try:
            if stat.S_ISREG(os.fstat(fd).st_mode):
                os.write(fd, data)
        finally:
            os.close(fd)
    except Exception:  # noqa: BLE001
        pass


def send_result(status: int | None) -> str:
    """HTTP の状態コードを送信の結果の種類にする（None は届かない）。"""
    if status is None:
        return "unreachable"
    if 200 <= status < 300:
        return "ok"
    if status == 409:
        return "conflict"
    return "rejected"
