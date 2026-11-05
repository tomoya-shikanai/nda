"""win.py の、Windows の部品から Element を作る部分の試験。
Windows 専用のライブラリは偽物に差し替えて import する（Mac でも回せる）。
"""

import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path
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


class _LegacyPattern:
    def __init__(self, value, state):
        self.Value = value
        self._state = state

    @property
    def State(self):
        if isinstance(self._state, Exception):
            raise self._state
        return self._state


class _Control:
    """uiautomation の Control の偽物。GetValuePattern は持たない（Custom・Pane などと同じ）。"""

    def __init__(self, control_type="CustomControl", value=None, is_password=False, legacy_value=None, legacy_state=0):
        self.Name = "単価"
        self.AutomationId = "edtPrice"
        self.ControlTypeName = control_type
        self.ClassName = "TEdit"
        self.IsPassword = is_password
        self.BoundingRectangle = _Rect(1, 2, 3, 4)
        self._value = value
        self._legacy_value = legacy_value
        self._legacy_state = legacy_state

    def GetPattern(self, pattern_id):
        if pattern_id == _PatternId.ValuePattern and self._value is not None:
            return _ValuePattern(self._value)
        if pattern_id == _PatternId.LegacyIAccessiblePattern and self._legacy_value is not None:
            return _LegacyPattern(self._legacy_value, self._legacy_state)
        return None


class _Process:
    """psutil.Process の偽物。"""

    def __init__(self, pid, name=""):
        self.pid = pid
        self.info = {"pid": pid, "name": name}


class _Window:
    def __init__(self, pid, title, handle=0):
        self.ProcessId = pid
        self.Name = title
        self.NativeWindowHandle = handle
        self.ClassName = "ThunderRT6FormDC"
        self.BoundingRectangle = _Rect(0, 0, 800, 600)


class _Listener:
    """pynput.mouse.Listener の偽物。"""

    def __init__(self, on_click=None):
        self.on_click = on_click

    def start(self):
        pass

    def stop(self):
        pass


class _KeyListener:
    """pynput.keyboard.Listener の偽物。"""

    def __init__(self, on_press=None, on_release=None):
        self.on_press, self.on_release = on_press, on_release

    def start(self):
        pass

    def stop(self):
        pass


class _SpecialKey:
    """pynput.keyboard.Key の要素の偽物（name を持つ）。"""

    def __init__(self, name):
        self.name = name


class _KeyCode:
    """pynput.keyboard.KeyCode の偽物（name を持たない）。"""

    def __init__(self, char=None, vk=None):
        self.char, self.vk = char, vk


class _TargetProcess:
    """対象のプロセスの偽物（Reader と dump_tree が使う所だけ）。"""

    def __init__(self, pid, name="RacroS.exe"):
        self.pid = pid
        self.info = {"pid": pid, "name": name}

    def is_running(self):
        return True

    def name(self):
        return self.info["name"]

    def exe(self):
        return r"C:\RacroS\RacroS.exe"


class _Image:
    """ImageGrab.grab が返す画像の偽物。保存したら印のファイルを作る。"""

    def convert(self, mode):
        return self

    def save(self, path, *a, **k):
        Path(path).write_bytes(b"jpg")


def _fake_modules():
    auto = types.ModuleType("uiautomation")
    auto.PatternId = _PatternId
    auto.GetRootControl = lambda: types.SimpleNamespace(GetChildren=lambda: [])
    pil = types.ModuleType("PIL")
    pil.ImageGrab = types.ModuleType("PIL.ImageGrab")
    pynput = types.ModuleType("pynput")
    pynput.mouse = types.ModuleType("pynput.mouse")
    pynput.mouse.Listener = _Listener
    pynput.keyboard = types.ModuleType("pynput.keyboard")
    pynput.keyboard.Listener = _KeyListener
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
        "pynput.keyboard": pynput.keyboard,
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

    def test_PROTECTED_が立った_legacy_の値は伏せる(self):
        e = self.win.element_of(_Control(legacy_value="secret", legacy_state=0x20000000 | 0x4))
        self.assertTrue(e.is_password)
        d = e.to_dict()
        self.assertEqual(d["value"], "***")
        self.assertNotIn("secret", str(d))

    def test_PROTECTED_が立った欄は_dump_にも元の値を出さない(self):
        e = self.win.element_of(_Control(legacy_value="secret", legacy_state=0x20000000))
        # dump_tree は e.is_password が真なら "***" を書く（同じ element_of の結果を使う）
        shown = "***" if e.is_password else repr(e.value[:80])
        self.assertEqual(shown, "***")

    def test_状態が読めない_legacy_の値は出さない(self):
        for state in (None, RuntimeError("取れない")):
            e = self.win.element_of(_Control(legacy_value="secret", legacy_state=state))
            self.assertEqual((e.value, e.value_source), (None, None))
            self.assertNotIn("secret", str(e.to_dict()))

    def test_PROTECTED_が無ければ_legacy_の値を読む(self):
        e = self.win.element_of(_Control(legacy_value="3300", legacy_state=0x4))
        self.assertEqual((e.value, e.value_source, e.is_password), ("3300", "legacy", False))

    def test_ValuePattern_で値が取れる欄でも_legacy_の_PROTECTED_で伏せる(self):
        e = self.win.element_of(_Control(value="secret", legacy_value="secret", legacy_state=0x20000000))
        self.assertTrue(e.is_password)
        d = e.to_dict()
        self.assertEqual(d["value"], "***")
        self.assertNotIn("secret", str(d))

    def test_ValuePattern_で値が取れても_legacy_の状態が読めなければ値を出さない(self):
        for state in (None, RuntimeError("取れない")):
            e = self.win.element_of(_Control(value="secret", legacy_value="x", legacy_state=state))
            self.assertEqual((e.value, e.value_source), (None, None))
            self.assertNotIn("secret", str(e.to_dict()))

    def test_legacy_が無い欄は_IsPassword_だけで判定する(self):
        e = self.win.element_of(_Control(value="2200"))
        self.assertEqual((e.value, e.value_source, e.is_password), ("2200", "value", False))
        e = self.win.element_of(_Control(value="secret", is_password=True))
        self.assertEqual(e.to_dict()["value"], "***")

    def test_IsPassword_が読めなければ値を出さない(self):
        class _NoIsPassword(_Control):
            @property
            def IsPassword(self):
                raise RuntimeError("取れない")

            @IsPassword.setter
            def IsPassword(self, v):
                pass

        for kw in ({"value": "secret"}, {"legacy_value": "secret"}):
            e = self.win.element_of(_NoIsPassword(**kw))
            self.assertIsNotNone(e, kw)
            self.assertEqual((e.value, e.value_source), (None, None), kw)
            self.assertNotIn("secret", str(e.to_dict()), kw)


class NameValueTest(unittest.TestCase):
    """RacroS III の TextEdit・NumEdit は、入力した値が Name に出る。Name を値として伏せる。"""

    NV = frozenset({"TextEdit", "NumEdit"})

    def setUp(self):
        self.win = _import_win(self)

    def _ctl(self, cls, name):
        c = _Control(control_type="PaneControl")
        c.ClassName, c.Name = cls, name
        return c

    def test_Name_に出る値は文字数だけ残す(self):
        e = self.win.element_of(self._ctl("TextEdit", "山田太郎"), self.NV)
        self.assertEqual((e.name, e.value, e.value_source, e.masked), ("", "山田太郎", "name", True))
        d = e.to_dict()
        self.assertEqual((d["name"], d["value"], d["value_len"]), ("", "***", 4))
        self.assertNotIn("山田", str(d))

    def test_入力の途中でも同じ部品に見える(self):
        a = self.win.element_of(self._ctl("NumEdit", "1"), self.NV)
        b = self.win.element_of(self._ctl("NumEdit", "1200"), self.NV)
        self.assertEqual(a.key(), b.key())

    def test_対象でないクラスは_Name_をそのまま残す(self):
        e = self.win.element_of(self._ctl("Button", "保存"), self.NV)
        self.assertEqual((e.name, e.masked), ("保存", False))

    def test_既定の設定で_TextEdit_と_NumEdit_を伏せる(self):
        from recorder.config import Config

        self.assertEqual(set(Config().name_value_classes), {"TextEdit", "NumEdit"})

    def test_パスワードの印があれば文字数も出さない(self):
        c = self._ctl("TextEdit", "secret")
        c.IsPassword = True
        d = self.win.element_of(c, self.NV).to_dict()
        self.assertEqual(d["value"], "***")
        self.assertNotIn("value_len", d)


class KeyKindTest(unittest.TestCase):
    def setUp(self):
        self.win = _import_win(self)

    def k(self, key, ctrl=False, alt=False, shift=False):
        return self.win.key_kind(key, ctrl, alt, shift)

    def test_特別なキーは名前を残す(self):
        self.assertEqual(self.k(_SpecialKey("tab")), "tab")
        self.assertEqual(self.k(_SpecialKey("tab"), shift=True), "shift+tab")
        self.assertEqual(self.k(_SpecialKey("f5")), "f5")

    def test_普通の文字は数えるだけ(self):
        self.assertEqual(self.k(_KeyCode(char="a", vk=0x41)), "")
        self.assertEqual(self.k(_KeyCode(char="A", vk=0x41), shift=True), "")
        self.assertEqual(self.k(_SpecialKey("space")), "")

    def test_修飾キーそのものは残さない(self):
        for n in ("ctrl_l", "shift", "alt_r"):
            self.assertIsNone(self.k(_SpecialKey(n)))

    def test_Ctrl_との組み合わせは英数字だけ残す(self):
        self.assertEqual(self.k(_KeyCode(char="\x13", vk=0x53), ctrl=True), "ctrl+S")
        self.assertEqual(self.k(_KeyCode(char=None, vk=0xBA), ctrl=True), "ctrl+?")


class KeyRecordTest(unittest.TestCase):
    """キーは対象のソフトが前面のときだけ数え、文字は数だけ残す。"""

    def setUp(self):
        from recorder.config import Config

        self.win = _import_win(self)
        self.reader = self.win.Reader(Config(target_exe=["RacroS.exe"]))
        self.reader.proc = _TargetProcess(PID)
        auto = sys.modules["uiautomation"]
        auto.GetForegroundControl = lambda: None
        auto.GetFocusedControl = lambda: None
        self.win.foreground_window = lambda: 100

    def _type(self, pid, keys):
        self.win.pid_of_window = lambda hwnd: pid
        for k in keys:
            self.reader._on_press(k)
            self.reader._on_release(k)

    def test_文字の数と特別なキーを残す(self):
        self._type(PID, [_KeyCode("a", 0x41), _KeyCode("b", 0x42), _SpecialKey("tab")])
        (k,) = self.reader.snapshot().keys
        self.assertEqual((k.key, k.chars_before, k.exe), ("tab", 2, "RacroS.exe"))

    def test_他のアプリで打ったキーは残さない(self):
        self._type(OTHER, [_KeyCode("a", 0x41), _SpecialKey("enter")])
        self.assertEqual(self.reader.snapshot().keys, [])
        self.assertEqual(self.reader.chars, 0)

    def test_Ctrl_を押している間だけ組み合わせになる(self):
        self.win.pid_of_window = lambda hwnd: PID
        ctrl = _SpecialKey("ctrl_l")
        self.reader._on_press(ctrl)
        self.reader._on_press(_KeyCode("\x13", 0x53))
        self.reader._on_release(ctrl)
        self.reader._on_press(_SpecialKey("enter"))
        self.assertEqual([k.key for k in self.reader.snapshot().keys], ["ctrl+S", "enter"])


class StageErrorTest(unittest.TestCase):
    """1 か所の読み取りの失敗で、その回のクリックをまとめて失わない。"""

    def setUp(self):
        from recorder.config import Config

        self.win = _import_win(self)
        self.reader = self.win.Reader(Config(target_exe=["RacroS.exe"]))
        self.reader.proc = _TargetProcess(PID)
        self.auto = sys.modules["uiautomation"]
        btn = _Control(control_type="ButtonControl")
        btn.ProcessId = PID
        self.auto.ControlFromPoint = lambda x, y: btn
        self.win.pid_at = lambda x, y: PID

    def _boom(self):
        raise RuntimeError("COM")

    def test_窓の読み取りに失敗してもクリックは残す(self):
        self.auto.GetForegroundControl = self._boom
        self.auto.GetFocusedControl = lambda: None
        self.reader._on_click(5, 6, "Button.left", True)
        s = self.reader.snapshot()
        self.assertEqual(len(s.clicks), 1)
        self.assertEqual(s.errors[0]["stage"], "window")

    def test_欄の読み取りに失敗しても窓は残す(self):
        w = _Window(PID, "整備伝票", handle=300)
        self.auto.GetForegroundControl = lambda: w
        self.auto.GetFocusedControl = self._boom
        s = self.reader.snapshot()
        self.assertIsNotNone(s.window)
        self.assertEqual([e["stage"] for e in s.errors], ["focus"])


class DialogButtonsTest(unittest.TestCase):
    def setUp(self):
        self.win = _import_win(self)

    def test_ダイアログのボタンの名前だけを返す(self):
        kids = [
            types.SimpleNamespace(ControlTypeName="TextControl", Name="データを保存しますか"),
            types.SimpleNamespace(ControlTypeName="ButtonControl", Name="はい(Y)"),
            types.SimpleNamespace(ControlTypeName="ButtonControl", Name="いいえ(N)"),
        ]
        w = types.SimpleNamespace(GetChildren=lambda: kids)
        self.assertEqual(self.win.dialog_buttons(w), ("はい(Y)", "いいえ(N)"))

    def test_読めなければ空(self):
        w = types.SimpleNamespace(GetChildren=lambda: (_ for _ in ()).throw(RuntimeError("x")))
        self.assertEqual(self.win.dialog_buttons(w), ())


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


PID = 42
OTHER = 99


class ScreenshotTest(unittest.TestCase):
    """前面の窓が対象のプロセスの同じ窓のときだけ撮る。"""

    def setUp(self):
        from recorder.config import Config
        from recorder.core import Window

        self.win = _import_win(self)
        self.reader = self.win.Reader(Config(target_exe=["RacroS.exe"]))
        self.reader.proc = _TargetProcess(PID)
        self.window = Window(handle=100, title="請求書入力", class_name="TForm", rect=(0, 0, 800, 600))
        self.grabs = []
        sys.modules["PIL.ImageGrab"].grab = lambda bbox=None, all_screens=False: self.grabs.append(bbox) or _Image()
        self.win.window_rect = lambda hwnd: (10, 20, 810, 620)
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.path = Path(d.name) / "0001-window.jpg"

    def _front(self, hwnds, pids):
        """foreground_window が呼ばれるたびに hwnds の順で返す。"""
        it = iter(hwnds)
        self.win.foreground_window = lambda: next(it)
        self.win.pid_of_window = lambda hwnd: pids.get(hwnd)

    def test_前面が対象の同じ窓なら撮る(self):
        self._front([100, 100], {100: PID})
        self.assertTrue(self.reader.screenshot(self.window, self.path))
        self.assertTrue(self.path.exists())
        self.assertEqual(self.grabs, [(10, 20, 810, 620)])  # 撮る直前の窓の位置で撮る

    def test_前面が他のアプリなら撮らない(self):
        self._front([200, 200], {100: PID, 200: OTHER})
        self.assertFalse(self.reader.screenshot(self.window, self.path))
        self.assertEqual(self.grabs, [])
        self.assertFalse(self.path.exists())

    def test_前面が対象の別の窓でも撮らない(self):
        self._front([101, 101], {100: PID, 101: PID})
        self.assertFalse(self.reader.screenshot(self.window, self.path))
        self.assertEqual(self.grabs, [])

    def test_同じ窓の番号でも別のプロセスなら撮らない(self):
        self._front([100, 100], {100: OTHER})  # 窓が閉じて番号が他のアプリに使い回された
        self.assertFalse(self.reader.screenshot(self.window, self.path))
        self.assertEqual(self.grabs, [])

    def test_撮っている間に前面が変わったら保存しない(self):
        self._front([100, 200], {100: PID, 200: OTHER})
        self.assertFalse(self.reader.screenshot(self.window, self.path))
        self.assertFalse(self.path.exists())

    def test_前面の窓が分からなければ撮らない(self):
        self._front([None, None], {})
        self.assertFalse(self.reader.screenshot(self.window, self.path))
        self.assertEqual(self.grabs, [])


class DumpScreenshotTest(unittest.TestCase):
    def setUp(self):
        from recorder.config import Config

        self.win = _import_win(self)
        self.cfg = Config(target_exe=["RacroS.exe"])
        sys.modules["psutil"].process_iter = lambda attrs=None: [_TargetProcess(PID)]
        auto = sys.modules["uiautomation"]
        auto.GetRootControl = lambda: types.SimpleNamespace(GetChildren=lambda: [_Window(PID, "請求書入力", handle=100)])
        auto.WalkControl = lambda w, includeTop=True, maxDepth=25: iter([])
        self.grabs = []
        sys.modules["PIL.ImageGrab"].grab = lambda bbox=None, all_screens=False: self.grabs.append(bbox) or _Image()
        self.win.window_rect = lambda hwnd: (0, 0, 800, 600)
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.out = Path(d.name)

    def test_前面が他のアプリなら_dump_でも撮らない(self):
        self.win.foreground_window = lambda: 200
        self.win.pid_of_window = lambda hwnd: {100: PID, 200: OTHER}.get(hwnd)
        self.assertIsNotNone(self.win.dump_tree(self.cfg, self.out))
        self.assertEqual(self.grabs, [])
        self.assertEqual(list(self.out.glob("*.jpg")), [])

    def test_前面が対象の窓なら_dump_で撮る(self):
        self.win.foreground_window = lambda: 100
        self.win.pid_of_window = lambda hwnd: {100: PID}.get(hwnd)
        self.win.dump_tree(self.cfg, self.out)
        self.assertEqual(len(list(self.out.glob("*.jpg"))), 1)


class ClickTest(unittest.TestCase):
    """クリックの瞬間に、その座標の窓のプロセスを確かめる。"""

    def setUp(self):
        from recorder.config import Config

        self.win = _import_win(self)
        self.reader = self.win.Reader(Config(target_exe=["RacroS.exe"]))
        self.reader.proc = _TargetProcess(PID)
        auto = sys.modules["uiautomation"]
        auto.GetForegroundControl = lambda: None
        auto.GetFocusedControl = lambda: None
        # 後で調べると、同じ座標に RacroS III の部品がある（窓が切り替わった後）
        ok = _Control(control_type="ButtonControl")
        ok.ProcessId = PID
        auto.ControlFromPoint = lambda x, y: ok

    def _click_on(self, pid):
        self.win.pid_at = lambda x, y: pid
        self.reader._on_click(5, 6, "Button.left", True)
        return self.reader.snapshot()

    def test_クリックの瞬間に他のアプリの窓なら捨てる(self):
        self.assertEqual(self._click_on(OTHER).clicks, [])

    def test_クリックの瞬間の窓が分からなければ捨てる(self):
        self.assertEqual(self._click_on(None).clicks, [])

    def test_クリックの瞬間に対象の窓なら残す(self):
        (c,) = self._click_on(PID).clicks
        self.assertEqual((c.x, c.y, c.button), (5, 6, "left"))


class MultiProcessTest(unittest.TestCase):
    """RacroS III は画面ごとに実行ファイルが分かれる。対象の名前のどのプロセスの窓・クリックも残し、他のアプリは捨てる。"""

    SCREEN = 43  # 対象の別の画面（例: M_NOU.exe）

    def setUp(self):
        from recorder.config import Config

        self.win = _import_win(self)
        self.reader = self.win.Reader(Config(target_exe=["RS_MENU.exe", "M_NOU.exe"]))
        self.reader.proc = _TargetProcess(PID, name="RS_MENU.exe")
        names = {PID: "RS_MENU.exe", self.SCREEN: "M_NOU.exe", OTHER: "chrome.exe"}

        class _P:
            def __init__(self, pid):
                if pid not in names:
                    raise ProcessLookupError(pid)
                self.pid = pid

            def name(self):
                return names[self.pid]

        sys.modules["psutil"].Process = _P
        self.auto = sys.modules["uiautomation"]
        self.auto.GetFocusedControl = lambda: None

    def _front(self, pid):
        w = _Window(pid, "整備伝票", handle=300)
        self.auto.GetForegroundControl = lambda: w

    def test_別の画面のプロセスの窓も残し_実行ファイル名を付ける(self):
        self._front(self.SCREEN)
        s = self.reader.snapshot()
        self.assertEqual(s.target_pid, PID)  # 記録の区切りは変わらない
        self.assertEqual((s.window.pid, s.window.exe), (self.SCREEN, "M_NOU.exe"))
        self.assertEqual(s.window.to_dict()["exe"], "M_NOU.exe")

    def test_他のアプリの窓は残さない(self):
        self._front(OTHER)
        self.assertIsNone(self.reader.snapshot().window)

    def test_読めないプロセスの窓は残さない(self):
        self._front(7)
        self.assertIsNone(self.reader.snapshot().window)

    def test_別の画面のプロセスのクリックも残す(self):
        self.auto.GetForegroundControl = lambda: None
        btn = _Control(control_type="ButtonControl")
        btn.ProcessId = self.SCREEN
        self.auto.ControlFromPoint = lambda x, y: btn
        self.win.pid_at = lambda x, y: self.SCREEN
        self.reader._on_click(5, 6, "Button.left", True)
        self.assertEqual(len(self.reader.snapshot().clicks), 1)

    def test_クリックの瞬間と後で調べた部品のプロセスが違えば捨てる(self):
        self.auto.GetForegroundControl = lambda: None
        btn = _Control(control_type="ButtonControl")
        btn.ProcessId = PID
        self.auto.ControlFromPoint = lambda x, y: btn
        self.win.pid_at = lambda x, y: self.SCREEN
        self.reader._on_click(5, 6, "Button.left", True)
        self.assertEqual(self.reader.snapshot().clicks, [])

    def test_別の画面の窓は_その窓のプロセスで撮る(self):
        from recorder.core import Window

        grabs = []
        self.win.grab_front = lambda hwnd, pid, path, q: grabs.append((hwnd, pid)) or True
        w = Window(handle=300, title="整備伝票", class_name="X", rect=(0, 0, 1, 1), pid=self.SCREEN, exe="M_NOU.exe")
        self.assertTrue(self.reader.screenshot(w, Path("x.jpg")))
        self.assertEqual(grabs, [(300, self.SCREEN)])

    def test_対象でないプロセスの窓は撮らない(self):
        from recorder.core import Window

        self.win.grab_front = lambda *a: self.fail("撮ってはいけない")
        w = Window(handle=300, title="x", class_name="X", rect=(0, 0, 1, 1), pid=OTHER)
        self.assertFalse(self.reader.screenshot(w, Path("x.jpg")))


if __name__ == "__main__":
    unittest.main()
