"""聞き役の本体（listen.py）のうち、音の装置を使わない部分: 合図音の鳴らし方（paplay → sounddevice）と、状態の知らせ。"""

import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import listen  # noqa: E402
from listener_core import cue_pcm  # noqa: E402


class FakeSd:
    def __init__(self):
        self.written = []

    def RawOutputStream(self, **kw):  # noqa: N802
        sd = self

        class S:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def write(self, pcm):
                sd.written.append(pcm)

        return S()


class BeepTest(unittest.TestCase):
    def test_paplayがあればstdinで鳴らしsounddeviceを開かない(self):
        sd = FakeSd()
        with mock.patch.object(listen.shutil, "which", return_value="/usr/bin/paplay"), mock.patch.object(listen.subprocess, "run") as run:
            listen.beep(sd, None, "wake")
        self.assertEqual(run.call_args.args[0][0], "paplay")
        self.assertEqual(run.call_args.kwargs["input"], cue_pcm("wake"))
        self.assertEqual(sd.written, [])

    def test_paplayが失敗したらsounddeviceに落ちる(self):
        sd = FakeSd()
        err = subprocess.CalledProcessError(1, "paplay")
        with mock.patch.object(listen.shutil, "which", return_value="/usr/bin/paplay"), mock.patch.object(listen.subprocess, "run", side_effect=err):
            listen.beep(sd, None, "end")
        self.assertEqual(sd.written, [cue_pcm("end")])

    def test_paplayが無ければsounddevice(self):
        sd = FakeSd()
        with mock.patch.object(listen.shutil, "which", return_value=None):
            listen.beep(sd, None, "wake")
        self.assertEqual(sd.written, [cue_pcm("wake")])


class NotifyTest(unittest.TestCase):
    def test_届かなくても投げずに早く戻る(self):
        t0 = time.monotonic()
        listen.notify("http://127.0.0.1:9", "listening", 8)
        listen.notify("http://127.0.0.1:9", "listening", 500)  # 上限を超える秒は 120 に丸める
        self.assertLess(time.monotonic() - t0, 2.0)

    def test_既定の値(self):
        a = listen.parse_args([])
        self.assertEqual((a.max_sec, a.first_voice_sec, a.ambient_factor, a.silence_rms), (15.0, 8.0, 2.5, 500.0))


if __name__ == "__main__":
    unittest.main()
