"""現場の聞き役。マイクを常時聞き、起動語「んだ クロード」で合図音を鳴らして録音し、/api/session/voice へ送る。

録音はメモリの中だけで、ファイルに残さない。起動語の判定はこの機械の中（Vosk、オフライン）。文字起こしはサーバーが STT に渡す。
使い方は README.md。設定は引数か環境変数（引数が優先）。
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import queue
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from listener_core import (  # noqa: E402
    DEFAULT_WAKE_CONF,
    GRAMMAR,
    RATE,
    Endpointer,
    ambient_threshold,
    cue_pcm,
    log_event,
    multipart,
    paplay_cmd,
    pick_device,
    rms,
    send_result,
    state_body,
    wake_conf,
    wav_bytes,
)

DEFAULT_MODEL = "/Users/dev/tools/nda/vosk-model-dl/vosk-model-small-ja-0.22"
BLOCK_SEC = 0.1


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    env = os.environ.get
    p = argparse.ArgumentParser(description="起動語で録音して nDa のサーバーへ送る")
    p.add_argument("--list-devices", action="store_true", help="音声デバイスの一覧を出して終わる")
    p.add_argument("--server", default=env("NDA_SERVER_URL", "http://127.0.0.1:3000"), help="サーバーの URL（NDA_SERVER_URL）")
    p.add_argument("--device", default=env("NDA_INPUT_DEVICE"), help="入力デバイス名の部分一致。無ければシステムの既定（NDA_INPUT_DEVICE）")
    p.add_argument("--output-device", default=env("NDA_OUTPUT_DEVICE"), help="合図音を鳴らすデバイス名の部分一致。無ければ既定（NDA_OUTPUT_DEVICE）")
    p.add_argument("--vendor", default=env("NDA_STT_VENDOR", "scribe"), choices=["scribe", "gemini"], help="STT（NDA_STT_VENDOR）")
    p.add_argument("--wake-conf", type=float, default=float(env("NDA_WAKE_CONF", DEFAULT_WAKE_CONF)), help="起動語の両語の conf の下限（NDA_WAKE_CONF）")
    p.add_argument(
        "--silence-rms", type=float, default=float(env("NDA_SILENCE_RMS", "500")), help="無音の閾値の下限 RMS（NDA_SILENCE_RMS）。周りがうるさければ上げる"
    )
    p.add_argument(
        "--ambient-factor", type=float, default=float(env("NDA_AMBIENT_FACTOR", "2.5")), help="閾値 = max(下限, 周りの RMS の中央値 × これ)（NDA_AMBIENT_FACTOR）"
    )
    p.add_argument(
        "--ambient-sec", type=float, default=float(env("NDA_AMBIENT_SEC", "3")), help="周りの音を測る、起動語を聞くまでの秒数（NDA_AMBIENT_SEC）"
    )
    p.add_argument("--silence-sec", type=float, default=float(env("NDA_SILENCE_SEC", "1.5")), help="声の後この秒数の無音で録音を止める（NDA_SILENCE_SEC）")
    p.add_argument("--max-sec", type=float, default=float(env("NDA_MAX_SEC", "15")), help="録音の最大秒数（NDA_MAX_SEC）")
    p.add_argument(
        "--first-voice-sec", type=float, default=float(env("NDA_FIRST_VOICE_SEC", "8")), help="合図の後、声が出るのを待つ秒数（NDA_FIRST_VOICE_SEC）"
    )
    p.add_argument("--model", default=env("NDA_VOSK_MODEL", DEFAULT_MODEL), help="Vosk のモデルのフォルダ（NDA_VOSK_MODEL）")
    p.add_argument("--log-dir", default=env("NDA_LOG_DIR"), help="出来事の記録の置き場。無ければ記録しない（NDA_LOG_DIR。Pi は /var/lib/nda/logs）")
    p.add_argument("--show-level", action="store_true", help="録音中の音量（RMS）を出す（無音の閾値を決めるとき）")
    return p.parse_args(argv)


def list_devices(sd) -> None:
    default_in, default_out = sd.default.device
    for i, d in enumerate(sd.query_devices()):
        kinds = []
        if d["max_input_channels"] > 0:
            kinds.append("入力" + ("（既定）" if i == default_in else ""))
        if d["max_output_channels"] > 0:
            kinds.append("出力" + ("（既定）" if i == default_out else ""))
        print(f"{i:3d}  {d['name']}  [{' / '.join(kinds)}]  {int(d['default_samplerate'])}Hz")


def beep(sd, device: int | None, kind: str = "wake") -> None:
    """合図音（wake: 上がりの 2 音、end: 下がりの 1 音）。鳴らせなくても聞き役は止めない。

    まず paplay で PipeWire の既定のシンク（Pi では Jabra）へ stdin から鳴らす（Pi では PipeWire が再生の装置を持っているので、
    sounddevice で hw を直に開くと busy になる）。paplay が無い・失敗したら sounddevice に落ちる。
    """
    pcm = cue_pcm(kind)
    if shutil.which("paplay"):
        try:
            subprocess.run(paplay_cmd(RATE), input=pcm, timeout=3, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except Exception as e:  # noqa: BLE001
            print(f"paplay で鳴らせなかった（{type(e).__name__}）。sounddevice で試す", file=sys.stderr)
    try:
        with sd.RawOutputStream(samplerate=RATE, channels=1, dtype="int16", device=device) as out:
            out.write(pcm)
    except Exception as e:  # noqa: BLE001
        print(f"合図音を鳴らせなかった（{type(e).__name__}）", file=sys.stderr)


def notify(server: str, state: str, until: float | None = None) -> None:
    """本体に聞き役の状態を知らせる（画面の「話してください」）。0.5 秒で諦め、失敗しても止まらない。"""
    try:
        req = urllib.request.Request(
            f"{server.rstrip('/')}/api/listener/state",
            data=state_body(state, None if until is None else min(until, 120.0)),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=0.5) as r:
            r.read()
    except Exception:  # noqa: BLE001
        pass


def drain(q: queue.Queue) -> None:
    while True:
        try:
            q.get_nowait()
        except queue.Empty:
            return


def record(q: queue.Queue, ep: Endpointer, show_level: bool, on_voice=None) -> bytes:
    """録音する。声が出始めたら on_voice(録音の残りの秒) を 1 回呼ぶ（画面の残り秒を録音の上限に切り替える）。"""
    chunks = []
    while True:
        data = q.get()
        chunks.append(data)
        level = rms(data)
        if show_level:
            print(f"  音量 {level:7.0f}", file=sys.stderr)
        was = ep.spoke
        stop = ep.feed(level, len(data) / 2 / RATE)
        if stop:
            return b"".join(chunks)
        if ep.spoke and not was and on_voice is not None:
            on_voice(max(0.1, ep.max_sec - ep.elapsed))


def send(server: str, vendor: str, wav: bytes) -> int | None:
    """送って HTTP の状態コードを返す。届かなければ None。"""
    body, ctype = multipart({"vendor": vendor}, "file", "voice.wav", "audio/wav", wav)
    req = urllib.request.Request(f"{server.rstrip('/')}/api/session/voice", data=body, method="POST", headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            j = json.loads(r.read())
            view = j.get("view", {})
            print(f"送った（{r.status}）: {view.get('state')} 「{view.get('say')}」")
            return r.status
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read()).get("error")
        except Exception:  # noqa: BLE001
            err = None
        if e.code == 409:
            # 聞いている間に作業が変わった（別の答えが入った・終わった）。古い声は当てていない
            print("作業が変わったので当てなかった。もう一度（起動語から）お願いします", flush=True)
        else:
            print(f"サーバーが断った（{e.code}）: {err}", file=sys.stderr)
        return e.code
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"サーバーに届かない: {getattr(e, 'reason', e)}", file=sys.stderr)
        return None


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    import sounddevice as sd

    if args.list_devices:
        list_devices(sd)
        return 0

    devices = list(sd.query_devices())
    try:
        dev_in = pick_device(devices, args.device, "input")
        dev_out = pick_device(devices, args.output_device, "output")
    except ValueError as e:
        print(e, file=sys.stderr)
        return 2

    import vosk

    vosk.SetLogLevel(-1)
    if not Path(args.model).is_dir():
        print(f"Vosk のモデルが無い: {args.model}", file=sys.stderr)
        return 2
    model = vosk.Model(args.model)
    rec = vosk.KaldiRecognizer(model, RATE, json.dumps(GRAMMAR, ensure_ascii=False))
    rec.SetWords(True)

    q: queue.Queue = queue.Queue()

    def on_audio(indata, frames, time, status) -> None:  # noqa: ARG001
        q.put(bytes(indata))

    name_in = devices[dev_in]["name"] if dev_in is not None else "システムの既定"
    with sd.RawInputStream(samplerate=RATE, blocksize=int(RATE * BLOCK_SEC), device=dev_in, dtype="int16", channels=1, callback=on_audio):
        print(f"起動語待ち（入力: {name_in}、送り先: {args.server}、STT: {args.vendor}）。止めるには Ctrl-C", flush=True)
        # 起動語を聞くまでの周りの音（塊ごとの RMS）。起動語そのものも入るので中央値で見る
        recent: collections.deque = collections.deque(maxlen=max(1, int(args.ambient_sec / BLOCK_SEC)))
        while True:
            data = q.get()
            recent.append(rms(data))
            if not rec.AcceptWaveform(data):
                continue
            conf = wake_conf(json.loads(rec.Result()))
            if conf is None:
                continue
            log_event("wake", {"conf": conf, "accepted": conf >= args.wake_conf, "minConf": args.wake_conf}, args.log_dir)
            if conf < args.wake_conf:  # is_wake と同じ判定
                continue
            levels = list(recent)
            threshold = ambient_threshold(levels, args.silence_rms, args.ambient_factor)
            ambient = ambient_threshold(levels, 0.0, 1.0)
            print(f"起動語を聞いた。話してください（無音の閾値 {threshold:.0f}）", flush=True)
            beep(sd, dev_out, "wake")
            notify(args.server, "listening", args.first_voice_sec)
            drain(q)  # 合図音と、それまでの音を録音に入れない
            ep = Endpointer(
                silence_rms=threshold, silence_sec=args.silence_sec, max_sec=args.max_sec, first_voice_sec=args.first_voice_sec
            )
            pcm = record(q, ep, args.show_level, lambda left: notify(args.server, "listening", left))
            log_event("record", {"sec": round(ep.elapsed, 2), "spoke": ep.spoke}, args.log_dir)
            log_event("level", {"threshold": round(threshold, 1), "ambient": round(ambient, 1)}, args.log_dir)
            if ep.spoke:
                beep(sd, dev_out, "end")
                notify(args.server, "sending")
                print(f"録音 {ep.elapsed:.1f} 秒。送ります", flush=True)
                t0 = time.monotonic()
                status = send(args.server, args.vendor, wav_bytes(pcm))
                ms = round((time.monotonic() - t0) * 1000)
                log_event("send", {"ms": ms, "status": status, "result": send_result(status)}, args.log_dir)
            else:
                print("声が無かったので送らない", flush=True)
            notify(args.server, "idle")
            recent.clear()
            pcm = b""
            drain(q)
            rec.Reset()
            print("起動語待ち", flush=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
