"""opener の Windows の部分。inputter.winsend.WinDesktop（読む・キー）に、起動・ツールバーを読む・クリック 1 回・一覧の OCR を足す。

クリックは左ボタンの 1 回だけ（Opener が新規のボタンを確かめてから呼ぶ）。一覧の文字は、画面を写して
Windows に入っている日本語の OCR（ocr.ps1）でこの PC の中だけで読む。写した画像は読み終えたら消す。
"""

from __future__ import annotations

import ctypes
import json
import os
import subprocess
import tempfile
from ctypes import wintypes
from pathlib import Path

from inputter.winsend import WinDesktop

OCR_PS1 = Path(__file__).with_name("ocr.ps1")
ROW_GAP_PX = 10  # OCR の行の上下の中心がこれより近ければ、同じ一覧の行とみる

INPUT_MOUSE = 0
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class _U(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT)]


class MINPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


class TBBUTTON(ctypes.Structure):
    _fields_ = [("iBitmap", ctypes.c_int), ("idCommand", ctypes.c_int), ("fsState", ctypes.c_ubyte), ("fsStyle", ctypes.c_ubyte),
                ("bReserved", ctypes.c_ubyte * 6), ("dwData", ctypes.c_size_t), ("iString", ctypes.c_ssize_t)]


class WinOpenDesktop(WinDesktop):
    def launch(self, exe_path: str, args: list[str], cwd: str) -> int:
        p = subprocess.Popen([exe_path, *args], cwd=cwd)
        return int(p.pid)

    def toolbar_buttons(self, hwnd: int, class_name: str):
        u, k = ctypes.windll.user32, ctypes.windll.kernel32
        u.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        u.SendMessageW.restype = ctypes.c_ssize_t
        k.VirtualAllocEx.restype = ctypes.c_void_p
        k.VirtualAllocEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD, wintypes.DWORD]
        k.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
        k.VirtualFreeEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD]
        found = []

        def cb(h, _):
            buf = ctypes.create_unicode_buffer(64)
            u.GetClassNameW(h, buf, 64)
            if buf.value == class_name:
                found.append(h)
            return True

        u.EnumChildWindows(hwnd, ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(cb), 0)
        if not found:
            return []
        tb = max(found, key=lambda h: u.SendMessageW(h, 0x0418, 0, 0))  # TB_BUTTONCOUNT
        n = u.SendMessageW(tb, 0x0418, 0, 0)
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(tb, ctypes.byref(pid))
        hp = k.OpenProcess(0x0008 | 0x0010 | 0x0020 | 0x0400, False, pid.value)
        if not hp:
            raise OSError("ツールバーの持ち主のプロセスを開けない")
        mem = k.VirtualAllocEx(hp, None, 4096, 0x3000, 0x04)
        out = []
        try:
            org = wintypes.RECT()
            u.GetWindowRect(tb, ctypes.byref(org))
            for i in range(n):
                b, r, got = TBBUTTON(), wintypes.RECT(), ctypes.c_size_t()
                u.SendMessageW(tb, 0x0417, i, mem)  # TB_GETBUTTON
                k.ReadProcessMemory(hp, mem, ctypes.byref(b), ctypes.sizeof(b), ctypes.byref(got))
                u.SendMessageW(tb, 0x041D, i, mem)  # TB_GETITEMRECT
                k.ReadProcessMemory(hp, mem, ctypes.byref(r), ctypes.sizeof(r), ctypes.byref(got))
                out.append((int(b.idCommand), int(b.fsState),
                            (org.left + r.left, org.top + r.top, org.left + r.right, org.top + r.bottom)))
        finally:
            k.VirtualFreeEx(hp, mem, 0, 0x8000)
            k.CloseHandle(hp)
        return out

    def click(self, x: int, y: int) -> None:
        u = ctypes.windll.user32
        if not u.SetCursorPos(int(x), int(y)):
            raise OSError("SetCursorPos が失敗した")
        arr = (MINPUT * 2)(MINPUT(type=INPUT_MOUSE), MINPUT(type=INPUT_MOUSE))
        arr[0].u.mi = MOUSEINPUT(0, 0, 0, MOUSEEVENTF_LEFTDOWN, 0, 0)
        arr[1].u.mi = MOUSEINPUT(0, 0, 0, MOUSEEVENTF_LEFTUP, 0, 0)
        u.SendInput.argtypes = [wintypes.UINT, ctypes.c_void_p, ctypes.c_int]
        if u.SendInput(2, arr, ctypes.sizeof(MINPUT)) != 2:
            # 押すだけが入って離すが入らないと、左ボタンが押されたままになるので、離すをもう一度送る（Codex の指摘）
            up = (MINPUT * 1)(MINPUT(type=INPUT_MOUSE))
            up[0].u.mi = MOUSEINPUT(0, 0, 0, MOUSEEVENTF_LEFTUP, 0, 0)
            u.SendInput(1, up, ctypes.sizeof(MINPUT))
            raise OSError("SendInput（クリック）が失敗した")

    def send_key(self, name: str) -> None:
        # opener だけ ↓・PageUp（一覧の行を移る）を送れる。ほかは inputter の許可リスト（Enter・Tab・BackSpace）
        vk = {"Down": 0x28, "PageUp": 0x21}.get(name)
        if vk is not None:
            from inputter.winsend import _key, _send
            _send([_key(vk, 0, 0), _key(vk, 0, 0x0002)])
            return
        super().send_key(name)

    def read_rows(self, rect):
        from PIL import ImageGrab

        left, top, right, bottom = rect
        img = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
        img = img.resize((img.width * 2, img.height * 2))
        fd, path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            img.save(path)
            p = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                                str(OCR_PS1), "-ImageFile", path], capture_output=True, timeout=60, check=False)
        finally:
            os.remove(path)
        if p.returncode != 0:
            raise OSError("OCR が失敗した")
        lines = json.loads(p.stdout.decode("utf-8-sig") or "[]")
        # 同じ高さの文字を 1 つの行にまとめる（一覧の列ごとに別の OCR の行になるため）
        rows: list[list[dict]] = []
        for ln in sorted(lines, key=lambda d: (d["y"] + d["bottom"]) / 2):
            mid = (ln["y"] + ln["bottom"]) / 2
            if rows and abs(mid - rows[-1][0]["mid"]) <= ROW_GAP_PX * 2:
                rows[-1].append({**ln, "mid": mid})
            else:
                rows.append([{**ln, "mid": mid}])
        return [" ".join(d["text"] for d in sorted(r, key=lambda d: d["x"])) for r in rows]
