"""Windows の画面を読む部分。Windows でだけ import する。

使うもの: uiautomation（画面部品の読み取り）、pynput（クリックとキーの検出）、Pillow（スクリーンショット）、psutil（プロセス）。
読むだけで、整備ソフトに入力・クリックはしない。キーは種類だけを残し、文字は数えるだけ。
"""

from __future__ import annotations

import ctypes
import queue
import time
from pathlib import Path

import psutil
import uiautomation as auto
from PIL import ImageGrab
from pynput import keyboard, mouse

from .config import Config
from .core import Click, Element, Key, Snapshot, Window, error_text


def set_dpi_aware() -> None:
    """座標とスクリーンショットの位置をそろえる（拡大表示の設定があっても）。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


# Win32 API は ctypes で直接呼ぶ。UIA と違い、pynput のスレッドからも安全に呼べる。
# Windows でない所（試験）では windll が無いので、どれも None を返す（安全側＝撮らない・捨てる）。


def foreground_window() -> int | None:
    """前面の窓のハンドル。"""
    try:
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        user32.GetForegroundWindow.restype = wintypes.HWND
        h = user32.GetForegroundWindow()
        return int(h) if h else None
    except Exception:
        return None


def pid_of_window(hwnd: int | None) -> int | None:
    """窓を持つプロセスの番号。"""
    if not hwnd:
        return None
    try:
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        pid = wintypes.DWORD(0)
        if not user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid)):
            return None
        return int(pid.value) or None
    except Exception:
        return None


def pid_at(x: int, y: int) -> int | None:
    """画面の座標にある窓のプロセスの番号。"""
    try:
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        user32.WindowFromPoint.argtypes = [wintypes.POINT]
        user32.WindowFromPoint.restype = wintypes.HWND
        h = user32.WindowFromPoint(wintypes.POINT(int(x), int(y)))
        return pid_of_window(int(h)) if h else None
    except Exception:
        return None


def window_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    """窓の今の位置。影の部分を含まない DWM の枠を優先し、取れなければ GetWindowRect。"""
    try:
        from ctypes import wintypes

        r = wintypes.RECT()
        DWMWA_EXTENDED_FRAME_BOUNDS = 9
        ok = False
        try:
            ok = ctypes.windll.dwmapi.DwmGetWindowAttribute(
                wintypes.HWND(hwnd), DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(r), ctypes.sizeof(r)
            ) == 0
        except Exception:
            ok = False
        if not ok:
            user32 = ctypes.windll.user32
            user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
            if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
                return None
        if r.right <= r.left or r.bottom <= r.top:
            return None
        return (int(r.left), int(r.top), int(r.right), int(r.bottom))
    except Exception:
        return None


def is_front(hwnd: int, pid: int) -> bool:
    """前面の窓が、対象のプロセスの、この窓そのものか。"""
    fg = foreground_window()
    return fg is not None and fg == hwnd and pid_of_window(fg) == pid


def grab_front(hwnd: int, pid: int, path: Path, quality: int) -> bool:
    """窓が前面にあるときだけ、その窓の範囲を撮って保存する。撮る前と撮った後の両方で確かめ、
    途中で前面が変わったら保存しない。常に手前に出る他の窓が重なっていれば写り込む（README に注意を書く）。"""
    try:
        if not is_front(hwnd, pid):
            return False
        rect = window_rect(hwnd)
        if rect is None:
            return False
        img = ImageGrab.grab(bbox=rect, all_screens=True)
        # 撮っている間に窓が動いた・縮んだら、前の範囲に他のアプリが写っている
        if not is_front(hwnd, pid) or window_rect(hwnd) != rect:
            return False
        img.convert("RGB").save(path, "JPEG", quality=quality)
        return True
    except Exception:
        return False


def _rect(r) -> tuple[int, int, int, int] | None:
    try:
        return (int(r.left), int(r.top), int(r.right), int(r.bottom))
    except Exception:
        return None


STATE_SYSTEM_PROTECTED = 0x20000000  # MSAA の状態。VB6 のパスワード欄は IsPassword でなくこれで分かる


def _read_value(c) -> tuple[str | None, str | None, bool | None]:
    """値と、どちらから読んだか（"value" | "legacy"）と、MSAA で保護された欄か（読めなければ None）。
    LegacyIAccessiblePattern があれば、どちらから値を読む場合も先にその状態を確かめる。
    状態が読めない（例外・None）部品は安全側に倒し、どちらの値も返さない。"""
    lp = None
    protected = False
    try:
        # VB6 の部品は ValuePattern を持たず、MSAA（LegacyIAccessiblePattern）だけを持つことがある。
        lp = c.GetPattern(auto.PatternId.LegacyIAccessiblePattern)
        if lp is not None:
            state = lp.State
            if state is None:
                return None, None, None
            protected = bool(state & STATE_SYSTEM_PROTECTED)
    except Exception:
        return None, None, None
    try:
        # GetValuePattern() は Edit・ComboBox など一部の部品クラスにしか無い。
        # GetPattern が返すパターンをそのまま使えば、Custom・Pane などの部品でも値が取れる。
        vp = c.GetPattern(auto.PatternId.ValuePattern)
        if vp is not None:
            v = vp.Value
            if v is not None:
                return v, "value", protected
    except Exception:
        pass
    try:
        if lp is not None:
            v = lp.Value
            if v is not None:
                return v, "legacy", protected
    except Exception:
        pass
    return None, None, protected


def element_of(c, name_value_classes: frozenset[str] = frozenset()) -> Element | None:
    """name_value_classes の部品（RacroS III の TextEdit・NumEdit）は、入力した値が Name に出る。
    Name を値として扱い、Name は空にする。入力のたびに別の部品に見えないようにもなる。
    値はどの部品でも記録には残さない（Element.to_dict で *** と文字数にする）。"""
    if c is None:
        return None
    try:
        value, value_source, protected = _read_value(c)
        known = protected is not None
        is_password = bool(protected)
        try:
            is_password = is_password or bool(c.IsPassword)
        except Exception:
            known = False
        if not known:
            # パスワード欄かどうか分からない部品は安全側に倒し、値（Name に出る値も）と文字数を残さない
            value, value_source = None, None
        name = c.Name or ""
        class_name = c.ClassName or ""
        if class_name in name_value_classes:
            return Element(
                name="",
                automation_id=c.AutomationId or "",
                control_type=c.ControlTypeName or "",
                class_name=class_name,
                value=name if known else None,
                value_source="name" if known else None,
                is_password=is_password,
                rect=_rect(c.BoundingRectangle),
            )
        return Element(
            name=name,
            automation_id=c.AutomationId or "",
            control_type=c.ControlTypeName or "",
            class_name=class_name,
            value=value,
            value_source=value_source,
            is_password=is_password,
            rect=_rect(c.BoundingRectangle),
        )
    except Exception:
        return None


def is_target(name: str, cfg: Config) -> bool:
    """実行ファイル名が target_exe のどれかと完全一致するか（大文字小文字は区別しない）。
    部分一致や窓の題名では選ばない。ブラウザのタブやフォルダの窓を対象にしないため。"""
    return name.lower() in {k.lower() for k in cfg.target_exe}


def exe_path(p: psutil.Process) -> str:
    try:
        return p.exe()
    except Exception:  # 権限が無いと読めない
        return ""


def find_target(cfg: Config) -> psutil.Process | None:
    for p in psutil.process_iter(["pid", "name"]):
        if is_target(p.info.get("name") or "", cfg):
            return p
    return None


def _foreground_target(cfg: Config) -> psutil.Process | None:
    """前面の窓のプロセスが対象なら返す（dump で、開いている画面のプロセスを選ぶため）。"""
    try:
        pid = pid_of_window(foreground_window())
        if pid is None:
            return None
        p = psutil.Process(pid)
        return p if is_target(p.name(), cfg) else None
    except Exception:
        return None


MODIFIERS = {"ctrl", "ctrl_l", "ctrl_r", "alt", "alt_l", "alt_r", "alt_gr", "shift", "shift_l", "shift_r", "cmd", "cmd_l", "cmd_r"}
CHAR_KEYS = {"space"}  # 文字として数えるだけの特別なキー


def key_kind(key, ctrl: bool, alt: bool, shift: bool) -> str | None:
    """キーを記録用の名前にする。普通の文字は "" （数えるだけ）、修飾キーそのものは None（記録しない）。
    文字そのものは返さない。Ctrl・Alt と一緒の英数字だけ、ショートカットとして "ctrl+S" のように返す。"""
    name = getattr(key, "name", None)
    if name is not None:  # 特別なキー（keyboard.Key）
        if name in MODIFIERS:
            return None
        if name in CHAR_KEYS and not (ctrl or alt):
            return ""
        mods = [m for m, on in (("ctrl", ctrl), ("alt", alt), ("shift", shift)) if on]
        return "+".join(mods + [name])
    if ctrl or alt:
        vk = getattr(key, "vk", None)
        if vk is not None and (0x30 <= vk <= 0x39 or 0x41 <= vk <= 0x5A):
            mods = [m for m, on in (("ctrl", ctrl), ("alt", alt), ("shift", shift)) if on]
            return "+".join(mods + [chr(vk)])
        return "+".join(m for m, on in (("ctrl", ctrl), ("alt", alt)) if on) + "+?"
    return ""


CUIAUTOMATION8 = "{e22ad333-b25f-460c-83d0-0581107395c9}"


def shorten_uia_timeouts(transaction_ms: int, connection_ms: int = 1000) -> bool:
    """UI Automation の 1 回の呼び出しの待ち時間を短くする。できたら True。

    既定（CUIAutomation）は 1 回 20 秒まで待つ。RacroS III が忙しいと時間切れ（0x80131505）が 3 回続き、
    記録が約 60 秒止まって画面の切り替わりを取りこぼしていた。待ち時間を変えられる CUIAutomation8 に替える。
    """
    try:
        import comtypes.client
        import uiautomation.uiautomation as u

        client = u._AutomationClient.instance()
        core = client.UIAutomationCore
        ia = comtypes.client.CreateObject(CUIAUTOMATION8, interface=core.IUIAutomation)
        ia2 = ia.QueryInterface(core.IUIAutomation2)
        ia2.ConnectionTimeout = connection_ms
        ia2.TransactionTimeout = transaction_ms
        client.IUIAutomation = ia
        client.ViewWalker = ia.RawViewWalker
        return True
    except Exception:
        return False  # 替えられなければ既定のまま記録する


class Reader:
    """画面の様子を 1 回分ずつ取る。"""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.uia_timeout_set = shorten_uia_timeouts(cfg.uia_timeout_ms) if cfg.uia_timeout_ms > 0 else False
        self.name_value_classes = frozenset(cfg.name_value_classes)
        self.clicks: queue.Queue[tuple[int, int, str, float, int | None, str]] = queue.Queue()
        self.keys: queue.Queue[tuple[str, float, str]] = queue.Queue()
        self.mods = {"ctrl": False, "alt": False, "shift": False}
        self.chars = 0  # 対象のソフトで、前の特別なキーの後に打った文字の数
        self.listener = mouse.Listener(on_click=self._on_click)
        self.listener.start()
        self.key_listener = keyboard.Listener(on_press=self._on_press, on_release=self._on_release)
        self.key_listener.start()
        self.last_find = 0.0
        # 記録の区切りに使う対象のプロセス（どれか 1 つ）。RacroS III は画面ごとに別のプロセスなので、
        # 窓・クリックは「対象の実行ファイル名のどのプロセスか」で判定する（_is_target_pid）。
        self.proc: psutil.Process | None = None
        self.proc_path = ""

    def _on_click(self, x, y, button, pressed) -> None:
        # pynput の別スレッドで呼ばれる。ここでは UIA を触らない。
        # 座標と、クリックの瞬間にその座標にあった窓のプロセス（Win32 API で取る）と、その実行ファイル名を積む。
        # 名前は後で調べると、プロセスが終わって pid が他のアプリに使い回されていることがあるので、その場で調べる
        if pressed:
            pid = pid_at(x, y)
            self.clicks.put((int(x), int(y), str(button).replace("Button.", ""), time.time(), pid, self._target_name(pid)))

    def _set_mod(self, key, on: bool) -> None:
        name = getattr(key, "name", None) or ""
        for m in ("ctrl", "alt", "shift"):
            if name.startswith(m):
                self.mods[m] = on

    def _on_press(self, key) -> None:
        # pynput の別スレッド。押した瞬間に前面の窓のプロセスが対象かを確かめ、他のアプリのキーは積まない
        try:
            self._set_mod(key, True)
            kind = key_kind(key, self.mods["ctrl"], self.mods["alt"], self.mods["shift"])
            if kind is not None:
                exe = self._target_name(pid_of_window(foreground_window()))
                if exe:
                    self.keys.put((kind, time.time(), exe))
        except Exception:
            pass

    def _on_release(self, key) -> None:
        try:
            self._set_mod(key, False)
        except Exception:
            pass

    def _target(self) -> psutil.Process | None:
        now = time.time()
        if self.proc is not None and self.proc.is_running():
            return self.proc
        if now - self.last_find < 2.0:
            return None
        self.last_find = now
        self.proc = find_target(self.cfg)
        self.proc_path = exe_path(self.proc) if self.proc is not None else ""
        return self.proc

    def _target_name(self, pid: int | None) -> str:
        """pid が対象の実行ファイル名のプロセスなら、その名前を返す。違う・分からなければ ""。
        pid は使い回されるので、結果を覚えずに毎回調べる（pynput のスレッドからも呼ぶ）。"""
        if not pid:
            return ""
        try:
            proc = self.proc
            if proc is not None and pid == proc.pid and proc.is_running():  # is_running は起動時刻まで比べる
                return proc.name()
            name = psutil.Process(pid).name()
        except Exception:  # 読めないプロセスは対象にしない
            return ""
        return name if is_target(name, self.cfg) else ""

    def snapshot(self) -> Snapshot:
        """読み取りは段階（窓・欄・クリック 1 つずつ）に分け、失敗した段階だけを捨てて s.errors に残す。
        1 か所の失敗で、その回のクリックやキーをまとめて失わないようにする。"""
        proc = self._target()
        clicks_raw = []
        while not self.clicks.empty():
            clicks_raw.append(self.clicks.get_nowait())
        keys_raw = []
        while not self.keys.empty():
            keys_raw.append(self.keys.get_nowait())
        if proc is None:
            return Snapshot(target_pid=None)
        pid = proc.pid
        s = Snapshot(target_pid=pid, target_exe=proc.name(), target_path=self.proc_path)

        def fail(stage: str, ex: Exception) -> None:
            s.errors.append({"stage": stage, "error": error_text(ex)})

        fg = None
        fg_pid = None
        fg_name = ""
        try:
            fg = auto.GetForegroundControl()
            fg_pid = fg.ProcessId if fg is not None else None
            fg_name = self._target_name(fg_pid)
            if fg is not None and fg_name:
                r = _rect(fg.BoundingRectangle)
                if r is not None:
                    class_name = fg.ClassName or ""
                    s.window = Window(
                        handle=fg.NativeWindowHandle, title=fg.Name or "", class_name=class_name, rect=r,
                        pid=fg_pid, exe=fg_name, buttons=dialog_buttons(fg) if class_name == "#32770" else (),
                    )
        except Exception as ex:
            fail("window", ex)
            fg_name = ""

        if fg is not None and fg_name:
            try:
                focus = auto.GetFocusedControl()
                if focus is not None and focus.ProcessId == fg_pid:
                    s.focus = element_of(focus, self.name_value_classes)
            except Exception as ex:
                fail("focus", ex)

        for x, y, button, at, click_pid, exe in clicks_raw:
            # クリックの瞬間に対象のソフトの窓でなければ捨てる（分からなければ捨てる）
            if not exe:
                continue
            try:
                c = auto.ControlFromPoint(x, y)
                # 対象のソフトの上のクリックだけを残す（クリックの瞬間と同じプロセスで、今も対象の名前の部品）
                if c is not None and c.ProcessId == click_pid and self._target_name(click_pid):
                    s.clicks.append(Click(x=x, y=y, button=button, element=element_of(c, self.name_value_classes), at=at, exe=exe))
            except Exception as ex:
                fail("click", ex)

        for kind, at, exe in keys_raw:  # 他のアプリで打ったキーは積んでいない（数えもしない）
            if kind == "":
                self.chars += 1
                continue
            s.keys.append(Key(key=kind, chars_before=self.chars, at=at, exe=exe))
            self.chars = 0
        return s

    def screenshot(self, window: Window, path: Path) -> bool:
        """前面の窓が対象のソフトのこの窓のときだけ撮る。違えば撮らない。"""
        pid = window.pid or (self.proc.pid if self.proc is not None else 0)
        if not pid or not self._target_name(pid):
            return False
        return grab_front(window.handle, pid, path, self.cfg.jpeg_quality)

    def stop(self) -> None:
        self.listener.stop()
        self.key_listener.stop()


def dialog_buttons(w) -> tuple[str, ...]:
    """確認のダイアログのボタンの名前（はい(Y)・いいえ(N) など）。文面は読まない。"""
    try:
        return tuple((ch.Name or "")[:20] for ch in w.GetChildren() if ch.ControlTypeName == "ButtonControl")
    except Exception:
        return ()


def dump_tree(cfg: Config, out: Path, max_depth: int = 25) -> Path | None:
    """対象のソフトの窓の部品ツリーを書き出す。読むだけ。
    スクリーンショットは、前面にある対象のソフトの窓だけを撮る（他のアプリが前面なら撮らない）。"""
    proc = _foreground_target(cfg) or find_target(cfg)
    if proc is None:
        return None
    windows = [w for w in auto.GetRootControl().GetChildren() if w.ProcessId == proc.pid]
    if not windows:
        return None
    out.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = out / f"dump-{stamp}.txt"
    patterns = [
        ("Value", auto.PatternId.ValuePattern),
        ("Invoke", auto.PatternId.InvokePattern),
        ("Grid", auto.PatternId.GridPattern),
        ("Table", auto.PatternId.TablePattern),
        ("Selection", auto.PatternId.SelectionPattern),
        ("LegacyIAccessible", auto.PatternId.LegacyIAccessiblePattern),
    ]
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"# process {proc.name()} pid={proc.pid} path={exe_path(proc)}\n")
        for i, w in enumerate(windows):
            if not proc.is_running():  # 書き出す途中で終わった（pid が他のアプリに使い回され得る）
                break
            for c, depth in auto.WalkControl(w, includeTop=True, maxDepth=max_depth):
                if _process_id(c) != proc.pid:  # 窓の中に入った他のプロセスの部品（埋め込みの窓など）は書かない
                    continue
                e = element_of(c, frozenset(cfg.name_value_classes))
                if e is None:
                    continue
                have = [n for n, pid in patterns if _has(c, pid)]
                d = e.to_dict()  # 名前・値は記録と同じく伏せる
                v = ""
                if "value" in d:
                    v = " value=***" + (f"({d['value_len']} 文字)" if "value_len" in d else "")
                    v += f" ({d['value_source']})" if "value_source" in d else ""
                n = d["name"][:80] + (f"({d['name_len']} 文字)" if "name_len" in d else "")
                f.write(
                    f"{'  ' * depth}{e.control_type} class={e.class_name!r} name={n!r} "
                    f"id={e.automation_id!r} rect={e.rect} patterns={have}{v}\n"
                )
            try:
                hwnd = int(w.NativeWindowHandle)
            except Exception:
                hwnd = 0
            if hwnd and proc.is_running() and grab_front(hwnd, proc.pid, out / f"dump-{stamp}-{i}.jpg", 80):
                f.write(f"# screenshot dump-{stamp}-{i}.jpg\n")
            else:
                f.write(f"# window {i}: 前面に無いので撮っていない\n")
    return path


def _process_id(c) -> int | None:
    try:
        return int(c.ProcessId)
    except Exception:
        return None


def _has(c, pid) -> bool:
    try:
        return bool(c.GetPattern(pid))
    except Exception:
        return False


def list_targets() -> str:
    """対象の実行ファイル名を確かめるため、窓を持つプロセスを一覧にする。
    窓の題名は出さない（他のアプリの題名に客の名前やメールの件名などが入り得る）。"""
    lines = []
    for w in auto.GetRootControl().GetChildren():
        try:
            p = psutil.Process(w.ProcessId)
            lines.append(f"{p.name():30} pid={p.pid:<6} class={w.ClassName!r}")
        except Exception:
            continue
    return "\n".join(sorted(set(lines)))
