"""send.py の Desktop の Windows の部分（薄く分ける）。--send のときだけ import する。

送れるのは キーボードの入力だけ（INPUT_KEYBOARD）。マウスの入力は作らない（構造体も持たない）。
キーは Enter・Tab・BackSpace の 3 つだけ、文字は数字・小数点（仮想キー）と、自由入力の欄の文字（Unicode）だけ。
F キー・Ctrl・Alt・Esc・Delete の仮想キーの番号は、この中に無い。
"""

from __future__ import annotations

import ctypes
import time
from ctypes import wintypes

from .send import FocusInfo, TopWindow, WindowInfo

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

# 送ってよいキー → 仮想キーの番号。ここに無い名前は送れない
KEY_VK = {"Enter": 0x0D, "Tab": 0x09, "BackSpace": 0x08}
DIGIT_VK = {str(d): 0x30 + d for d in range(10)}  # 上の段の数字
DIGIT_VK["."] = 0xBE  # VK_OEM_PERIOD

# 人の入力・押されたままのキーを見る仮想キー（読むだけ）
HELD_VK = (0x10, 0x11, 0x12, 0x5B, 0x5C, 0x01, 0x02, 0x04)  # Shift・Ctrl・Alt・左右 Win・マウスの左右中
VK_KANA = 0x15

ULONG_PTR = ctypes.c_size_t


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


# INPUT の大きさは、共用体の中で一番大きいマウスの入力の構造体で決まる。マウスの入力は作らないので、大きさだけを埋める
_UNION_SIZE = 32 if ctypes.sizeof(ctypes.c_void_p) == 8 else 24


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("_size", ctypes.c_ubyte * _UNION_SIZE)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


def _key(vk: int, scan: int, flags: int) -> INPUT:
    i = INPUT(type=INPUT_KEYBOARD)
    i.u.ki = KEYBDINPUT(wVk=vk, wScan=scan, dwFlags=flags, time=0, dwExtraInfo=0)
    return i


def key_inputs(name: str) -> list[INPUT]:
    """送ってよいキー 1 つの、押す・離すの 2 つ。許可の外なら ValueError。"""
    if name not in KEY_VK:
        raise ValueError(f"送ってよいキーでない: {name!r}")
    vk = KEY_VK[name]
    return [_key(vk, 0, 0), _key(vk, 0, KEYEVENTF_KEYUP)]


def char_inputs(ch: str) -> list[INPUT]:
    """文字 1 つ。数字・小数点は仮想キー、それ以外の印字できる文字は Unicode（VK_PACKET）。"""
    if not isinstance(ch, str) or len(ch) != 1 or not ch.isprintable() or ord(ch) > 0xFFFF:
        raise ValueError("送ってよい文字でない")
    if ch in DIGIT_VK:
        vk = DIGIT_VK[ch]
        return [_key(vk, 0, 0), _key(vk, 0, KEYEVENTF_KEYUP)]
    return [_key(0, ord(ch), KEYEVENTF_UNICODE), _key(0, ord(ch), KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]


def _send_input(inputs: list[INPUT]) -> int:
    user32 = ctypes.windll.user32
    user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
    user32.SendInput.restype = wintypes.UINT
    arr = (INPUT * len(inputs))(*inputs)
    return int(user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT)))


def _send(inputs: list[INPUT]) -> None:
    # 押す・離すは 1 回の SendInput で送る（間に他の入力が挟まらない）
    for i in inputs:
        if i.type != INPUT_KEYBOARD:
            raise ValueError("キーボードの入力でない")
    n = _send_input(inputs)
    if n != len(inputs):
        raise OSError(f"SendInput が {n}/{len(inputs)} しか送れなかった")


def _class_name(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    ctypes.windll.user32.GetClassNameW(wintypes.HWND(hwnd), buf, 256)
    return buf.value


def _title(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(512)
    ctypes.windll.user32.GetWindowTextW(wintypes.HWND(hwnd), buf, 512)
    return buf.value


def _rect(r) -> tuple[int, int, int, int] | None:
    try:
        return (int(r.left), int(r.top), int(r.right), int(r.bottom))
    except Exception:
        return None


class WinDesktop:
    """読むのは Win32 と UI Automation、送るのは SendInput のキーボードだけ。読めなければ None（止まる側）。"""

    def __init__(self) -> None:
        from recorder import win

        self._win = win
        win.set_dpi_aware()  # 位置は記録（recorder）と同じ画素でそろえる
        win.shorten_uia_timeouts(2000)
        self._human = False
        self._start_hooks()

    # -- 人の入力（低水準のフック。読むだけで、入力を止めたり書き換えたりしない） --

    def _start_hooks(self) -> None:
        from pynput import keyboard, mouse

        def seen(*args):
            # pynput は最後の引数に injected（SendInput などで作られた入力か）を渡す
            if not args[-1]:
                self._human = True

        self._listeners = [
            keyboard.Listener(on_press=seen, on_release=seen),
            mouse.Listener(on_move=seen, on_click=seen, on_scroll=seen),
        ]
        for listener in self._listeners:
            listener.start()
        for listener in self._listeners:
            listener.wait()

    def human_input_seen(self) -> bool:
        # フックが止まっていたら、人の入力を見られないので、見たことにして止める
        return self._human or not all(listener.is_alive() for listener in self._listeners)

    def reset_human_input(self) -> None:
        self._human = False

    def close(self) -> None:
        for listener in self._listeners:
            listener.stop()

    def foreground(self) -> WindowInfo | None:
        try:
            import psutil
            import uiautomation as auto

            h = self._win.foreground_window()
            pid = self._win.pid_of_window(h)
            if not h or not pid:
                return None
            # 窓の位置は、記録と同じ UI Automation の枠で取る（keypath の位置は記録から測った）
            rect = _rect(auto.ControlFromHandle(h).BoundingRectangle)
            if rect is None:
                return None
            return WindowInfo(hwnd=h, pid=pid, exe=psutil.Process(pid).name(), class_name=_class_name(h), title=_title(h), rect=rect)
        except Exception:
            return None

    def focused(self) -> FocusInfo | None:
        try:
            import uiautomation as auto

            c = auto.GetFocusedControl()
            if c is None:
                return None
            rect = _rect(c.BoundingRectangle)
            if rect is None:
                return None
            return FocusInfo(pid=int(c.ProcessId), class_name=c.ClassName or "", rect=rect, name=c.Name or "")
        except Exception:
            return None

    def windows_of(self, pid: int) -> list[TopWindow]:
        user32 = ctypes.windll.user32
        found: list[TopWindow] = []
        proto = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def cb(hwnd, _):
            try:
                if user32.IsWindowVisible(hwnd) and self._win.pid_of_window(int(hwnd)) == pid:
                    found.append(TopWindow(hwnd=int(hwnd), class_name=_class_name(int(hwnd)), title=_title(int(hwnd))))
            except Exception:
                # 1 つでも読めない窓があれば、ダイアログが無いと言えないので止める側にする（Codex の指摘）
                found.append(TopWindow(hwnd=0, class_name="#32770", title=""))
            return True

        if not user32.EnumWindows(proto(cb), 0):
            # 窓の一覧が取れなければ、ダイアログが無いと言えないので止める側にする
            return [TopWindow(hwnd=0, class_name="#32770", title="")]
        return found

    def last_input_tick(self) -> int:
        info = LASTINPUTINFO(cbSize=ctypes.sizeof(LASTINPUTINFO))
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
            raise OSError("GetLastInputInfo が失敗した")
        return int(info.dwTime)

    def tick_now(self) -> int:
        ctypes.windll.kernel32.GetTickCount.restype = wintypes.DWORD
        return int(ctypes.windll.kernel32.GetTickCount())

    def cursor_pos(self) -> tuple[int, int]:
        p = wintypes.POINT()
        if not ctypes.windll.user32.GetCursorPos(ctypes.byref(p)):
            raise OSError("GetCursorPos が失敗した")
        return (int(p.x), int(p.y))

    def keys_held(self) -> bool:
        user32 = ctypes.windll.user32
        user32.GetAsyncKeyState.restype = ctypes.c_short
        user32.GetKeyState.restype = ctypes.c_short
        if any(user32.GetAsyncKeyState(vk) & 0x8000 for vk in HELD_VK):
            return True
        # かな固定が入っていると、数字のキーがかなになり得る
        return bool(user32.GetKeyState(VK_KANA) & 1)

    def send_key(self, name: str) -> None:
        _send(key_inputs(name))

    def send_char(self, ch: str) -> None:
        _send(char_inputs(ch))

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)
