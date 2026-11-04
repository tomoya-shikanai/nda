"""win.py の、Windows の部品から Element を作る部分の試験。
Windows 専用のライブラリは偽物に差し替えて import する（Mac でも回せる）。
"""

import importlib
import sys
import types
import unittest
from unittest import mock


class _PatternId:
    # uiautomation 2.0.29 の PatternId の値
    InvokePattern = 10000
    SelectionPattern = 10001
    ValuePattern = 10002
    GridPattern = 10006
    TablePattern = 10012
    LegacyIAccessiblePattern = 10018


class _Rect:
    def __init__(self, left, top, right, bottom):
        self.left, self.top, self.right, self.bottom = left, top, right, bottom


class _ValuePattern:
    def __init__(self, value):
        self.Value = value


class _Control:
    """uiautomation の Control の偽物。GetValuePattern は持たない（Custom・Pane などと同じ）。"""

    def __init__(self, control_type="CustomControl", value=None, is_password=False, legacy_value=None):
        self.Name = "単価"
        self.AutomationId = "edtPrice"
        self.ControlTypeName = control_type
        self.ClassName = "TEdit"
        self.IsPassword = is_password
        self.BoundingRectangle = _Rect(1, 2, 3, 4)
        self._value = value
        self._legacy_value = legacy_value

    def GetPattern(self, pattern_id):
        if pattern_id == _PatternId.ValuePattern and self._value is not None:
            return _ValuePattern(self._value)
        if pattern_id == _PatternId.LegacyIAccessiblePattern and self._legacy_value is not None:
            return _ValuePattern(self._legacy_value)  # Value だけ使うので同じ形でよい
        return None


class _Process:
    """psutil.Process の偽物。"""

    def __init__(self, pid, name=""):
        self.pid = pid
        self.info = {"pid": pid, "name": name}


class _Window:
    def __init__(self, pid, title):
        self.ProcessId = pid
        self.Name = title


def _fake_modules():
    auto = types.ModuleType("uiautomation")
    auto.PatternId = _PatternId
    auto.GetRootControl = lambda: types.SimpleNamespace(GetChildren=lambda: [])
    pil = types.ModuleType("PIL")
    pil.ImageGrab = types.ModuleType("PIL.ImageGrab")
    pynput = types.ModuleType("pynput")
    pynput.mouse = types.ModuleType("pynput.mouse")
    psutil = types.ModuleType("psutil")
    psutil.Process = _Process
    psutil.process_iter = lambda attrs=None: []
    return {
        "uiautomation": auto,
        "psutil": psutil,
        "PIL": pil,
        "PIL.ImageGrab": pil.ImageGrab,
        "pynput": pynput,
        "pynput.mouse": pynput.mouse,
    }


def _import_win(case):
    """偽物のライブラリで recorder.win を読み込み直す。"""
    patcher = mock.patch.dict(sys.modules, _fake_modules())
    patcher.start()
    case.addCleanup(patcher.stop)  # recorder.win も sys.modules から外れる
    sys.modules.pop("recorder.win", None)
    # `from recorder import win` だと、前の試験で読んだ古い win（古い偽物を握ったもの）が返る
    return importlib.import_module("recorder.win")


class ElementOfTest(unittest.TestCase):
    def setUp(self):
        self.win = _import_win(self)

    def test_GetValuePattern_を持たない部品でも値を取る(self):
        e = self.win.element_of(_Control(value="2200"))
        self.assertEqual(e.value, "2200")
        self.assertEqual((e.name, e.automation_id, e.control_type, e.class_name), ("単価", "edtPrice", "CustomControl", "TEdit"))
        self.assertEqual(e.rect, (1, 2, 3, 4))

    def test_ValuePattern_が無い部品は値なし(self):
        self.assertIsNone(self.win.element_of(_Control(control_type="ButtonControl")).value)

    def test_パスワード欄の印が付く(self):
        self.assertTrue(self.win.element_of(_Control(value="secret", is_password=True)).is_password)


class LegacyValueTest(unittest.TestCase):
    def setUp(self):
        self.win = _import_win(self)

    def test_ValuePattern_がある部品は_value_から読む(self):
        e = self.win.element_of(_Control(value="2200", legacy_value="9999"))
        self.assertEqual((e.value, e.value_source), ("2200", "value"))
        self.assertEqual(e.to_dict()["value_source"], "value")

    def test_ValuePattern_が無い部品は_legacy_から読む(self):
        e = self.win.element_of(_Control(legacy_value="3300"))
        self.assertEqual((e.value, e.value_source), ("3300", "legacy"))
        self.assertEqual(e.to_dict()["value"], "3300")
        self.assertEqual(e.to_dict()["value_source"], "legacy")

    def test_ValuePattern_の値が取れないときも_legacy_から読む(self):
        c = _Control(value="x", legacy_value="3300")
        orig = c.GetPattern

        def get(pid):
            if pid == _PatternId.ValuePattern:
                raise RuntimeError("取れない")
            return orig(pid)

        c.GetPattern = get
        self.assertEqual(self.win.element_of(c).value_source, "legacy")

    def test_どちらも無ければ値なし(self):
        e = self.win.element_of(_Control())
        self.assertEqual((e.value, e.value_source), (None, None))
        self.assertNotIn("value_source", e.to_dict())

    def test_パスワード欄は_legacy_でも伏せる(self):
        e = self.win.element_of(_Control(legacy_value="secret", is_password=True))
        d = e.to_dict()
        self.assertEqual(d["value"], "***")
        self.assertNotIn("secret", str(d))


class FindTargetTest(unittest.TestCase):
    def setUp(self):
        from recorder.config import Config

        self.win = _import_win(self)
        self.cfg = Config(target_exe=["RacroS.exe"])

    def _find(self, procs, windows=()):
        sys.modules["psutil"].process_iter = lambda attrs=None: list(procs)
        sys.modules["uiautomation"].GetRootControl = lambda: types.SimpleNamespace(GetChildren=lambda: list(windows))
        return self.win.find_target(self.cfg)

    def test_題名だけが一致する窓は対象にならない(self):
        procs = [_Process(1, "chrome.exe"), _Process(2, "explorer.exe")]
        windows = [_Window(1, "RacroS III の使い方 - Google Chrome"), _Window(2, "RacroS")]
        self.assertIsNone(self._find(procs, windows))

    def test_名前が完全一致のときだけ対象になる(self):
        for name in ["RacroS.exe.bak", "NotRacroS.exe", "RacroS", "racros3.exe"]:
            self.assertIsNone(self._find([_Process(1, name)]), name)
        self.assertEqual(self._find([_Process(1, "racros_helper.exe"), _Process(7, "RacroS.exe")]).pid, 7)

    def test_名前は大文字小文字を区別しない(self):
        self.assertEqual(self._find([_Process(3, "RACROS.EXE")]).pid, 3)


if __name__ == "__main__":
    unittest.main()
