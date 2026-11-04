"""現場の聞き役の、音声を使わずに試せる部分（起動語の判定・録音の止め時・WAV と multipart の組み立て・デバイスの選び方）。
標準ライブラリだけを使う（vosk・sounddevice を import しない）。
"""

from __future__ import annotations

import io
import math
import uuid
import wave
from array import array
from dataclasses import dataclass

# 起動語。Vosk の grammar に渡す（docs/experiments.md の 2026-11-04 の行で決めた形）。
WAKE_WORDS = ("んだ", "クロード")
GRAMMAR = ["んだ クロード", "[unk]"]
# 両語の conf の下限（架空の読み上げ 5/5・誤検出 0/10 だった値。工場の騒音で確かめ直す）
DEFAULT_WAKE_CONF = 0.9

RATE = 16000
# 秒の足し算（0.1 を 50 回）の誤差で 1 塊遅れないための余裕
_EPS = 1e-9


def is_wake(result: dict, words: tuple[str, ...] = WAKE_WORDS, min_conf: float = DEFAULT_WAKE_CONF) -> bool:
    """Vosk の最終結果（SetWords(True) の result）に、起動語の語が並びのとおり続けて出て、どの語も conf ≥ min_conf なら True。

    並びの途中に別の語が入る・語が欠ける・conf が足りない・result が無いなら False（推測で起動しない）。
    例: 「なんだ、クローゼットか」→「んだ んだ クロード」(conf 0.65) は conf で落ちる。
    """
    items = result.get("result")
    if not isinstance(items, list):
        return False
    seq = []
    for it in items:
        if not isinstance(it, dict):
            return False
        w, c = it.get("word"), it.get("conf")
        if not isinstance(w, str) or not isinstance(c, (int, float)):
            return False
        seq.append((w, float(c)))
    n = len(words)
    for i in range(len(seq) - n + 1):
        window = seq[i : i + n]
        if all(w == want and c >= min_conf for (w, c), want in zip(window, words)):
            return True
    return False


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
