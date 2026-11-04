"""常駐の処理（__main__.py の tick・終了処理、indicator.py の loop）の試験。
記録の失敗、失敗の記録の失敗でも常駐を止めない。Windows 専用の部分は偽物に差し替える。
"""

import io
import sys
import types
import unittest
from contextlib import redirect_stderr
from unittest import mock

from recorder import __main__ as main
from recorder.config import Config
from recorder.core import Snapshot


class _BrokenStore:
    """何を書いても失敗する保存先（容量不足・権限の喪失など）。"""

    def __init__(self, *a, **k):
        self.dir = None
        self.writes = 0

    def write(self, e):
        self.writes += 1
        raise OSError("書けない")

    def screenshot_path(self, reason):
        return None


class _Reader:
    instances = []

    def __init__(self, cfg, ticks=3):
        self.left = ticks
        self.stopped = False
        _Reader.instances.append(self)

    def snapshot(self):
        if self.left == 0:
            raise KeyboardInterrupt
        self.left -= 1
        return Snapshot(target_pid=10, target_exe="RacroS.exe")

    def screenshot(self, window, path):
        return False

    def stop(self):
        self.stopped = True


def _fake_win():
    win = types.ModuleType("recorder.win")
    win.set_dpi_aware = lambda: None
    win.Reader = _Reader
    return win


class RunTest(unittest.TestCase):
    def setUp(self):
        _Reader.instances.clear()
        patches = [
            mock.patch.dict(sys.modules, {"recorder.win": _fake_win()}),
            mock.patch.object(main, "load", lambda: Config(show_indicator=False, poll_sec=0)),
            mock.patch.object(main, "Store", _BrokenStore),
            mock.patch.object(main, "cleanup", lambda *a, **k: []),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_保存も失敗の記録も失敗しても常駐を続け_終了処理まで進む(self):
        err = io.StringIO()
        with redirect_stderr(err):
            main.run()  # 例外を出さずに戻る（KeyboardInterrupt で止まる）
        (reader,) = _Reader.instances
        self.assertEqual(reader.left, 0)  # 3 回とも tick が回った
        self.assertTrue(reader.stopped)  # 終了時の flush が失敗しても reader.stop() まで進む
        lines = err.getvalue().splitlines()
        self.assertTrue(lines and all("OSError" in x for x in lines), lines)


class _Root:
    def __init__(self):
        self.pending = []

    def after(self, ms, fn):
        self.pending.append(fn)

    def mainloop(self):
        for _ in range(3):
            fn = self.pending.pop(0)
            try:
                fn()
            except Exception:
                pass  # tkinter は after の中の例外を表示して続ける


class IndicatorLoopTest(unittest.TestCase):
    def test_tick_が例外を出しても次の呼び出しを登録する(self):
        with mock.patch.dict(sys.modules, {"tkinter": types.ModuleType("tkinter")}):
            sys.modules.pop("recorder.indicator", None)
            from recorder.indicator import Indicator

            sys.modules.pop("recorder.indicator", None)
        ind = Indicator.__new__(Indicator)
        ind.root = _Root()
        calls = []

        def tick():
            calls.append(1)
            raise RuntimeError("壊れた")

        ind.loop(tick, 300)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(ind.root.pending), 1)


if __name__ == "__main__":
    unittest.main()
