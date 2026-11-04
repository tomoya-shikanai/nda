"""記録の判定と保存。Windows に依存しない部分だけを置き、Mac でも試験できるようにする。

画面の様子（Snapshot）を受け取り、前回と比べて「何が起きたか」（イベント）を返す。
記録するのは対象のソフト（RacroS III）の操作だけ。他のアプリの操作は記録しない。
キー入力そのものは記録せず、欄から離れたときの値の変化として残す（パスワード欄は伏せる）。
"""

from __future__ import annotations

import json
import shutil
import time
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

MAX_VALUE = 500
MASK = "***"


@dataclass(frozen=True)
class Element:
    """画面部品 1 つの要約。"""

    name: str = ""
    automation_id: str = ""
    control_type: str = ""
    class_name: str = ""
    value: str | None = None
    is_password: bool = False
    value_source: str | None = None  # "value"（ValuePattern）か "legacy"（LegacyIAccessiblePattern）
    rect: tuple[int, int, int, int] | None = None

    def key(self) -> tuple[str, str, str, str]:
        """同じ部品かどうかの判定に使う（値と位置は含めない）。"""
        return (self.name, self.automation_id, self.control_type, self.class_name)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "name": self.name[:MAX_VALUE],
            "automation_id": self.automation_id,
            "control_type": self.control_type,
            "class_name": self.class_name,
        }
        if self.value is not None:
            d["value"] = MASK if self.is_password else self.value[:MAX_VALUE]
            if self.value_source is not None:
                d["value_source"] = self.value_source
        if self.rect is not None:
            d["rect"] = list(self.rect)
        return d


@dataclass(frozen=True)
class Window:
    handle: int
    title: str
    class_name: str
    rect: tuple[int, int, int, int]
    # 窓を持つプロセス。RacroS III は画面ごとに実行ファイルが分かれるので、窓ごとに持つ（0・空は不明）
    pid: int = 0
    exe: str = ""

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"handle": self.handle, "title": self.title, "class_name": self.class_name, "rect": list(self.rect)}
        if self.exe:
            d["exe"] = self.exe
        return d


@dataclass(frozen=True)
class Click:
    x: int
    y: int
    button: str
    element: Element | None
    at: float


@dataclass
class Snapshot:
    """ある瞬間の様子。対象のソフト以外の窓・部品は、取得側で None にしてから渡す。"""

    target_pid: int | None
    target_exe: str = ""
    target_path: str = ""  # 実行ファイルのパス。読めなければ空
    window: Window | None = None
    focus: Element | None = None
    clicks: list[Click] = field(default_factory=list)


@dataclass
class Event:
    kind: str
    data: dict[str, Any]
    screenshot: str | None = None  # 撮る理由（撮らないなら None）


SCREENSHOT_CONTROL_TYPES = {"ButtonControl", "MenuItemControl", "TabItemControl", "ListItemControl", "HyperlinkControl"}


class Tracker:
    """前回の様子と比べて、記録するイベントを決める。"""

    def __init__(self) -> None:
        self.pid: int | None = None
        self.window: Window | None = None
        self.focus: Element | None = None
        self.focus_value_at_enter: str | None = None
        # 今の部品にフォーカスがある間に、一度でもパスワード欄・保護された欄と判定されたか。
        # 立ったら部品を離れるまで下ろさない（保護中に読んだ値を後で before・after に出さない）
        self.focus_protected = False

    def observe(self, s: Snapshot) -> list[Event]:
        events: list[Event] = []

        if s.target_pid != self.pid:
            if self.pid is not None:
                events += self._leave_focus()
                events.append(Event("session_end", {"pid": self.pid}))
                self.window = None
                self.focus = None
                self.focus_protected = False
            if s.target_pid is not None:
                events.append(Event("session_start", {"pid": s.target_pid, "exe": s.target_exe, "path": s.target_path}))
            self.pid = s.target_pid
        if s.target_pid is None:
            return events

        if s.window is not None and (self.window is None or (s.window.handle, s.window.title) != (self.window.handle, self.window.title)):
            events.append(Event("window", s.window.to_dict(), screenshot="window"))
        if s.window is not None:
            self.window = s.window

        for c in s.clicks:
            d: dict[str, Any] = {"x": c.x, "y": c.y, "button": c.button}
            if c.element is not None:
                d["element"] = c.element.to_dict()
            shot = "click" if c.element is not None and c.element.control_type in SCREENSHOT_CONTROL_TYPES else None
            events.append(Event("click", d, screenshot=shot))

        if s.focus is not None and (self.focus is None or s.focus.key() != self.focus.key()):
            events += self._leave_focus()
            events.append(Event("focus", s.focus.to_dict()))
            self.focus = s.focus
            self.focus_value_at_enter = s.focus.value
            self.focus_protected = s.focus.is_password
        elif s.focus is not None:
            self.focus = s.focus  # 同じ部品。値だけ更新される
            self.focus_protected = self.focus_protected or s.focus.is_password
        return events

    def _leave_focus(self) -> list[Event]:
        f = self.focus
        if f is None or f.value is None or f.value == self.focus_value_at_enter:
            return []
        before = self.focus_value_at_enter
        hide = self.focus_protected or f.is_password
        if hide:
            f = replace(f, is_password=True)
        return [
            Event(
                "value_changed",
                {
                    "element": f.to_dict(),
                    "before": MASK if hide else (before or "")[:MAX_VALUE],
                    "after": MASK if hide else f.value[:MAX_VALUE],
                },
            )
        ]

    def flush(self) -> list[Event]:
        """終了時。入力途中の欄の値の変化も残す。"""
        events = self._leave_focus()
        if self.pid is not None:
            events.append(Event("session_end", {"pid": self.pid}))
        self.pid = None
        self.focus = None
        self.focus_protected = False
        return events


class Store:
    """<root>/<YYYY-MM-DD>/session-<HHMMSS>/events.jsonl と screenshots/ に書く。
    日付が変わったら新しい日付のフォルダに切り替え（session_continue を先頭に書く）、
    書く前に保存先が無ければ作り直す（長く動かしている間に消されても止まらない）。"""

    def __init__(self, root: Path, min_shot_interval: float = 2.0, clock=time.time) -> None:
        self.root = root
        self.min_shot_interval = min_shot_interval
        self.clock = clock
        self.dir: Path | None = None
        self.day: str | None = None
        self.shots = 0
        self.last_shot = -1e9

    def open_session(self) -> Path:
        now = datetime.fromtimestamp(self.clock())
        self.day = now.strftime("%Y-%m-%d")
        self.dir = self.root / self.day / now.strftime("session-%H%M%S")
        (self.dir / "screenshots").mkdir(parents=True, exist_ok=True)
        self.shots = 0
        return self.dir

    def close_session(self) -> None:
        self.dir = None
        self.day = None

    def _append(self, rec: dict[str, Any]) -> None:
        assert self.dir is not None
        self.dir.mkdir(parents=True, exist_ok=True)
        with open(self.dir / "events.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def write(self, e: Event) -> None:
        at = datetime.fromtimestamp(self.clock())
        if e.kind == "session_start" or self.dir is None:
            self.open_session()
        elif at.strftime("%Y-%m-%d") != self.day:
            prev = self.dir
            self.open_session()
            self._append({"at": at.isoformat(timespec="milliseconds"), "kind": "session_continue", "from": f"{prev.parent.name}/{prev.name}"})
        self._append({"at": at.isoformat(timespec="milliseconds"), "kind": e.kind, **e.data})
        if e.kind == "session_end":
            self.close_session()

    def screenshot_path(self, reason: str) -> Path | None:
        """撮ってよければ保存先を返す。短い間隔で撮りすぎない。"""
        now = self.clock()
        if self.dir is None or now - self.last_shot < self.min_shot_interval:
            return None
        self.last_shot = now
        self.shots += 1
        shots = self.dir / "screenshots"
        shots.mkdir(parents=True, exist_ok=True)
        return shots / f"{self.shots:04d}-{reason}.jpg"


def cleanup(root: Path, keep_days: int, today: date | None = None, active: Path | None = None) -> list[Path]:
    """keep_days より古い日付のフォルダと、dumps の中の更新日が keep_days より古いファイルを消す。
    日付の形でないフォルダには触らない。active（今書いているセッションのフォルダ）を含む日付のフォルダは消さない。"""
    today = today or date.today()
    limit = today - timedelta(days=keep_days)
    removed: list[Path] = []
    if not root.exists():
        return removed
    for d in sorted(root.iterdir()):
        try:
            day = date.fromisoformat(d.name)
        except ValueError:
            continue
        if active is not None and active.is_relative_to(d):
            continue
        if d.is_dir() and day < limit:
            shutil.rmtree(d)
            removed.append(d)
    dumps = root / "dumps"
    if dumps.is_dir():
        for f in sorted(dumps.iterdir()):
            if f.is_file() and date.fromtimestamp(f.stat().st_mtime) < limit:
                f.unlink()
                removed.append(f)
    return removed
