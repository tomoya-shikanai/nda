"""win.py の、Windows の部品から Element を作る部分の試験。
Windows 専用のライブラリは偽物に差し替えて import する（Mac でも回せる）。
"""

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

    def __init__(self, control_type="CustomControl", value=None, is_password=False):
        self.Name = "単価"
        self.AutomationId = "edtPrice"
        self.ControlTypeName = control_type
        self.ClassName = "TEdit"
        self.IsPassword = is_password
        self.BoundingRectangle = _Rect(1, 2, 3, 4)
        self._value = value

    def GetPattern(self, pattern_id):
        if pattern_id == _PatternId.ValuePattern and self._value is not None:
            return _ValuePattern(self._value)
        return None


def _fake_modules():
    auto = types.ModuleType("uiautomation")
    auto.PatternId = _PatternId
    pil = types.ModuleType("PIL")
    pil.ImageGrab = types.ModuleType("PIL.ImageGrab")
    pynput = types.ModuleType("pynput")
    pynput.mouse = types.ModuleType("pynput.mouse")
    return {
        "uiautomation": auto,
        "psutil": types.ModuleType("psutil"),
        "PIL": pil,
        "PIL.ImageGrab": pil.ImageGrab,
        "pynput": pynput,
        "pynput.mouse": pynput.mouse,
    }


class ElementOfTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(sys.modules, _fake_modules())
        patcher.start()
        self.addCleanup(patcher.stop)  # recorder.win も sys.modules から外れる
        sys.modules.pop("recorder.win", None)
        from recorder import win

        self.win = win

    def test_GetValuePattern_を持たない部品でも値を取る(self):
        e = self.win.element_of(_Control(value="2200"))
        self.assertEqual(e.value, "2200")
        self.assertEqual((e.name, e.automation_id, e.control_type, e.class_name), ("単価", "edtPrice", "CustomControl", "TEdit"))
        self.assertEqual(e.rect, (1, 2, 3, 4))

    def test_ValuePattern_が無い部品は値なし(self):
        self.assertIsNone(self.win.element_of(_Control(control_type="ButtonControl")).value)

    def test_パスワード欄の印が付く(self):
        self.assertTrue(self.win.element_of(_Control(value="secret", is_password=True)).is_password)


if __name__ == "__main__":
    unittest.main()
