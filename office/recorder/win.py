"""Windows の画面を読む部分。Windows でだけ import する。

使うもの: uiautomation（画面部品の読み取り）、pynput（クリックの検出）、Pillow（スクリーンショット）、psutil（プロセス）。
読むだけで、整備ソフトに入力・クリックはしない。
"""

from __future__ import annotations

import ctypes
import queue
import time
from pathlib import Path

import psutil
import uiautomation as auto
from PIL import ImageGrab
from pynput import mouse

from .config import Config
from .core import Click, Element, Snapshot, Window


def set_dpi_aware() -> None:
    """座標とスクリーンショットの位置をそろえる（拡大表示の設定があっても）。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def _rect(r) -> tuple[int, int, int, int] | None:
    try:
        return (int(r.left), int(r.top), int(r.right), int(r.bottom))
    except Exception:
        return None


STATE_SYSTEM_PROTECTED = 0x20000000  # MSAA の状態。VB6 のパスワード欄は IsPassword でなくこれで分かる


def _read_value(c) -> tuple[str | None, str | None, bool]:
    """値と、どちらから読んだか（"value" | "legacy"）と、MSAA で保護された欄か。
    ValuePattern が無いか値が取れないときだけ legacy を読む。legacy は状態が読めなければ値を捨てる。"""
    try:
        # GetValuePattern() は Edit・ComboBox など一部の部品クラスにしか無い。
        # GetPattern が返すパターンをそのまま使えば、Custom・Pane などの部品でも値が取れる。
        vp = c.GetPattern(auto.PatternId.ValuePattern)
        if vp is not None:
            v = vp.Value
            if v is not None:
                return v, "value", False
    except Exception:
        pass
    try:
        # VB6 の部品は ValuePattern を持たず、MSAA（LegacyIAccessiblePattern）だけを持つことがある。
        lp = c.GetPattern(auto.PatternId.LegacyIAccessiblePattern)
        if lp is not None:
            # 状態が読めない（例外・None）ときは安全側に倒し、値を記録しない。
            state = lp.State
            if state is not None:
                v = lp.Value
                if v is not None:
                    return v, "legacy", bool(state & STATE_SYSTEM_PROTECTED)
    except Exception:
        pass
    return None, None, False


def element_of(c) -> Element | None:
    if c is None:
        return None
    try:
        value, value_source, protected = _read_value(c)
        is_password = protected
        try:
            is_password = protected or bool(c.IsPassword)
        except Exception:
            pass
        return Element(
            name=c.Name or "",
            automation_id=c.AutomationId or "",
            control_type=c.ControlTypeName or "",
            class_name=c.ClassName or "",
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


class Reader:
    """画面の様子を 1 回分ずつ取る。"""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.clicks: queue.Queue[tuple[int, int, str, float]] = queue.Queue()
        self.listener = mouse.Listener(on_click=self._on_click)
        self.listener.start()
        self.last_find = 0.0
        self.proc: psutil.Process | None = None
        self.proc_path = ""

    def _on_click(self, x, y, button, pressed) -> None:
        # pynput の別スレッドで呼ばれる。ここでは UIA を触らず、座標だけ積む。
        if pressed:
            self.clicks.put((int(x), int(y), str(button).replace("Button.", ""), time.time()))

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

    def snapshot(self) -> Snapshot:
        proc = self._target()
        clicks_raw = []
        while not self.clicks.empty():
            clicks_raw.append(self.clicks.get_nowait())
        if proc is None:
            return Snapshot(target_pid=None)
        pid = proc.pid
        s = Snapshot(target_pid=pid, target_exe=proc.name(), target_path=self.proc_path)

        fg = auto.GetForegroundControl()
        if fg is not None and fg.ProcessId == pid:
            r = _rect(fg.BoundingRectangle)
            if r is not None:
                s.window = Window(handle=fg.NativeWindowHandle, title=fg.Name or "", class_name=fg.ClassName or "", rect=r)
            focus = auto.GetFocusedControl()
            if focus is not None and focus.ProcessId == pid:
                s.focus = element_of(focus)

        for x, y, button, at in clicks_raw:
            try:
                c = auto.ControlFromPoint(x, y)
            except Exception:
                c = None
            # 対象のソフトの上のクリックだけを残す
            if c is not None and c.ProcessId == pid:
                s.clicks.append(Click(x=x, y=y, button=button, element=element_of(c), at=at))
        return s

    def screenshot(self, rect: tuple[int, int, int, int], path: Path) -> bool:
        try:
            img = ImageGrab.grab(bbox=rect, all_screens=True)
            img.convert("RGB").save(path, "JPEG", quality=self.cfg.jpeg_quality)
            return True
        except Exception:
            return False

    def stop(self) -> None:
        self.listener.stop()


def dump_tree(cfg: Config, out: Path, max_depth: int = 25) -> Path | None:
    """対象のソフトの前面の窓の部品ツリーを書き出す。読むだけ。"""
    proc = find_target(cfg)
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
            for c, depth in auto.WalkControl(w, includeTop=True, maxDepth=max_depth):
                e = element_of(c)
                if e is None:
                    continue
                have = [n for n, pid in patterns if _has(c, pid)]
                v = "" if e.value is None else (" value=" + ("***" if e.is_password else repr(e.value[:80])))
                if e.value is not None and e.value_source == "legacy":
                    v += " (legacy)"
                f.write(
                    f"{'  ' * depth}{e.control_type} class={e.class_name!r} name={e.name[:80]!r} "
                    f"id={e.automation_id!r} rect={e.rect} patterns={have}{v}\n"
                )
            r = _rect(w.BoundingRectangle)
            if r is not None:
                try:
                    ImageGrab.grab(bbox=r, all_screens=True).convert("RGB").save(out / f"dump-{stamp}-{i}.jpg", "JPEG", quality=80)
                except Exception:
                    pass
    return path


def _has(c, pid) -> bool:
    try:
        return bool(c.GetPattern(pid))
    except Exception:
        return False


def list_targets() -> str:
    """対象の実行ファイル名を確かめるため、窓を持つプロセスを一覧にする。"""
    lines = []
    for w in auto.GetRootControl().GetChildren():
        try:
            p = psutil.Process(w.ProcessId)
            lines.append(f"{p.name():30} pid={p.pid:<6} class={w.ClassName!r:40} title={w.Name!r}")
        except Exception:
            continue
    return "\n".join(sorted(set(lines)))
