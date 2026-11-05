"""記録の判定と保存。Windows に依存しない部分だけを置き、Mac でも試験できるようにする。

画面の様子（Snapshot）を受け取り、前回と比べて「何が起きたか」（イベント）を返す。
記録するのは対象のソフト（RacroS III）の操作だけ。他のアプリの操作は記録しない。
キー入力の文字そのものは記録しない。Tab・Enter・F キーなどの種類と、その前に打った文字の数だけを残す。
欄の値は、欄から離れたときの変化として残す（値は *** と文字数だけ。パスワード欄は文字数も残さない）。
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
    value_source: str | None = None  # "value"（ValuePattern）か "legacy"（LegacyIAccessiblePattern）か "name"
    rect: tuple[int, int, int, int] | None = None

    def key(self) -> tuple[str, str, str, str]:
        """同じ部品かどうかの判定に使う（値と位置は含めない）。"""
        return (self.name, self.automation_id, self.control_type, self.class_name)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            **record_name(self.control_type, self.name),
            "automation_id": self.automation_id,
            "control_type": self.control_type,
            "class_name": self.class_name,
        }
        if self.value is not None:
            # 欄の値は客の名前などが入り得るので、どの部品でも残さない。パスワード欄は文字数も残さない
            d["value"] = MASK
            if not self.is_password:
                d["value_len"] = len(self.value)
            if self.value_source is not None:
                d["value_source"] = self.value_source
        if self.rect is not None:
            d["rect"] = list(self.rect)
        return d


# 名前が画面の決まった文字（ボタンの名前・メニュー・タブなど）の部品。これ以外の部品の名前は、
# 一覧の行の客の名前・ダイアログの文面・欄の値などが入り得るので、*** と文字数だけを残す
NAME_CONTROL_TYPES = {
    "ButtonControl", "SplitButtonControl", "MenuBarControl", "MenuControl", "MenuItemControl", "TabControl",
    "TabItemControl", "CheckBoxControl", "RadioButtonControl", "ToolBarControl", "HeaderControl", "HeaderItemControl",
    "ScrollBarControl", "GroupControl",
}


def record_name(control_type: str, name: str) -> dict[str, Any]:
    """部品の名前を記録に残す形にする（{"name": ...} と、伏せたら {"name_len": ...}）。"""
    if control_type in TITLE_CONTROL_TYPES:
        # 窓・題名の帯の部品は、名前が窓の題名と同じなので、客の名前を伏せる
        return {"name": mask_title(name)[:MAX_VALUE]}
    if control_type in NAME_CONTROL_TYPES or not name:
        return {"name": name[:MAX_VALUE]}
    return {"name": MASK, "name_len": len(name)}


@dataclass(frozen=True)
class Window:
    handle: int
    title: str
    class_name: str
    rect: tuple[int, int, int, int]
    # 窓を持つプロセス。RacroS III は画面ごとに実行ファイルが分かれるので、窓ごとに持つ（0・空は不明）
    pid: int = 0
    exe: str = ""
    # 確認のダイアログ（#32770）のボタンの名前。文面は残さない
    buttons: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"handle": self.handle, "title": mask_title(self.title), "class_name": self.class_name, "rect": list(self.rect)}
        if self.exe:
            d["exe"] = self.exe
        if self.buttons:
            d["buttons"] = list(self.buttons)
        return d


@dataclass(frozen=True)
class Click:
    x: int
    y: int
    button: str
    element: Element | None
    at: float
    exe: str = ""  # クリックした窓の実行ファイル名


@dataclass(frozen=True)
class Key:
    """特別なキー 1 回（Tab・Enter・F キーなど）。普通の文字は数だけ（chars_before）。"""

    key: str
    chars_before: int
    at: float
    exe: str = ""


@dataclass
class Snapshot:
    """ある瞬間の様子。対象のソフト以外の窓・部品は、取得側で None にしてから渡す。"""

    target_pid: int | None
    target_exe: str = ""
    target_path: str = ""  # 実行ファイルのパス。読めなければ空
    window: Window | None = None
    focus: Element | None = None
    clicks: list[Click] = field(default_factory=list)
    keys: list[Key] = field(default_factory=list)
    errors: list[dict[str, str]] = field(default_factory=list)  # 読み取りの段階ごとの失敗（stage, error）


@dataclass
class Event:
    kind: str
    data: dict[str, Any]
    screenshot: str | None = None  # 撮る理由（撮らないなら None）
    # 初めて入った欄の目印（画面の実行ファイル・クラス・窓の中の位置）。撮れたら Tracker.field_shot_done に返す
    field_key: tuple | None = None


# 初めて入った欄では画面を 1 枚撮る。欄の見出しと位置を対応づけ、欄の地図を作るため（画像は PC の中だけ）
FIELD_SHOT_CLASSES = {"NumEdit", "TextEdit", "ThunderRT6TextBox"}

SCREENSHOT_CONTROL_TYPES = {"ButtonControl", "MenuItemControl", "TabItemControl", "ListItemControl", "HyperlinkControl"}

# ツールバー（msvb_lib_toolbar）のボタンには名前が無い。帯の左端からのボタンの中心の位置（画素）で名前を決める。
# 2026-11-05 に事務所の PC（1920×1080、拡大 100%）の画面で測った。版の更新や拡大の設定で変わり得る。
# 伝票（M_NOU）は、新しく入れるときと、作った伝票を開いたときとでボタンの並びが変わる。並びは UIA で読めないので、
# 並びごとの表を持ち、押した位置で候補が 1 つに決まらなければ「転用|新規」のように候補を並べて残す。
TOOLBAR_CLASS = "msvb_lib_toolbar"
TOOLBAR_HALF_WIDTH = 27
TOOLBARS: dict[str, tuple[dict[str, int], ...]] = {
    "m_nou.exe": (
        {  # 新しく入れるとき
            "終了": 25, "中止": 80, "削除": 135, "自社名": 190, "転用": 245, "保存": 355, "印保存": 405, "印刷": 465,
            "車情報": 520, "マスタ": 630, "類似検": 685, "点数検": 740, "付箋": 850, "シール": 1015, "参照": 1125, "設定": 1180,
        },
        {  # 作った伝票を開いたとき（修正を押すまで保存・印保存は押せない）
            "終了": 25, "中止": 80, "削除": 135, "自社名": 190, "新規": 245, "修正": 300, "保存": 355, "印保存": 405,
            "印刷": 465, "転用": 520, "返品": 575, "額振替": 630, "説明書": 685, "付箋": 850, "前候補": 905, "次候補": 960,
            "シール": 1070, "参照": 1125, "設定": 1180,
        },
    ),
    "m_car.exe": (
        {
            "終了": 25, "中止": 80, "保存": 135, "印刷": 190, "検索": 245, "保有車": 300, "客追加": 355, "客修正": 410,
            "客削除": 465, "車追加": 520, "車修正": 575, "車削除": 630, "車移動": 685, "画像": 740, "付箋": 850,
            "前候補": 905, "次候補": 960, "参照": 1015, "対応メモ": 1070,
        },
    ),
}


def toolbar_button(exe: str, element: Element | None, x: int) -> str | None:
    """ツールバーのクリックなら、押した位置からボタンの名前を返す。

    並びが幾つかある画面で候補が割れたら「転用|新規」のように並べる。分からなければ "?"、ツールバーでなければ None。
    """
    if element is None or element.class_name != TOOLBAR_CLASS or element.rect is None:
        return None
    dx = x - element.rect[0]
    names: list[str] = []
    for table in TOOLBARS.get(exe.lower(), ()):
        name, center = min(table.items(), key=lambda kv: abs(kv[1] - dx))
        if abs(center - dx) <= TOOLBAR_HALF_WIDTH and name not in names:
            names.append(name)
    return "|".join(names) if names else "?"


TITLE_CONTROL_TYPES = {"WindowControl", "TitleBarControl"}


def mask_title(title: str) -> str:
    """窓の題名から客の名前を伏せる。

    RacroS III の題名は「[ 客の名前 ] - [ 画面の名前 ] - RacroSⅢ」の形で、客を選ぶと先頭に名前が入る。
    「 - 」で区切って 3 つ以上あれば、後ろの 2 つ（画面の名前とソフトの名前）だけを残し、前は *** にする。
    """
    parts = title.split(" - ")
    if len(parts) < 3:
        return title
    return " - ".join(["***"] * (len(parts) - 2) + parts[-2:])


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
        self.shot_fields: set[tuple] = set()

    def field_shot_done(self, key: tuple) -> None:
        """初めて入った欄の画面が撮れた。同じ欄ではもう撮らない（撮れなければ次に入ったときに撮り直す）。"""
        self.shot_fields.add(key)

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

        for err in s.errors:
            events.append(Event("error", dict(err)))

        for c in s.clicks:
            d: dict[str, Any] = {"x": c.x, "y": c.y, "button": c.button}
            if c.exe:
                d["exe"] = c.exe
            if c.element is not None:
                d["element"] = c.element.to_dict()
            tb = toolbar_button(c.exe, c.element, c.x)
            if tb is not None:
                d["toolbar_button"] = tb
                if c.element is not None and c.element.rect is not None:
                    d["toolbar_dx"] = c.x - c.element.rect[0]
            shot = "click" if tb is not None or (c.element is not None and c.element.control_type in SCREENSHOT_CONTROL_TYPES) else None
            events.append(Event("click", d, screenshot=shot))

        for k in s.keys:
            d = {"key": k.key, "chars_before": k.chars_before}
            if k.exe:
                d["exe"] = k.exe
            events.append(Event("key", d))

        if s.focus is not None and (self.focus is None or s.focus.key() != self.focus.key()):
            events += self._leave_focus()
            d = s.focus.to_dict()
            if s.window is not None and s.window.exe:
                d["exe"] = s.window.exe
            fk = None
            if s.focus.class_name in FIELD_SHOT_CLASSES and s.focus.rect is not None and s.window is not None:
                r, w = s.focus.rect, s.window.rect
                fk = (s.window.exe.lower(), s.focus.class_name, r[0] - w[0], r[1] - w[1], r[2] - r[0], r[3] - r[1])
                if fk in self.shot_fields:
                    fk = None
            events.append(Event("focus", d, screenshot="field" if fk else None, field_key=fk))
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
        d: dict[str, Any] = {"element": f.to_dict(), "before": MASK, "after": MASK}
        if not hide:
            d.update(before_len=len(before or ""), after_len=len(f.value))
        return [Event("value_changed", d)]

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
