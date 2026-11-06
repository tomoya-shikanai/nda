"""人が伝票の画面で自分で Enter を押す間、フォーカスの移り変わりを読むだけで keypath と照らす（キー・クリックは送らない）。

土曜日の確かめの最初の段で使う。見るもの:
- フォーカスのある部品のクラス・位置（窓の左上から）・幅が、keypath のどの欄に当たるか
- 欄から欄への移り変わりが、keypath の順（項目CD → 作業内容 → 作業区分 → 担当 → 数量 → 単価 → 次の行）どおりか
- 欄の値の「形」（空・数字・カンマつき・小数点つき）。値そのものは出さない
- ダイアログ・小窓が出たか（題名は出さない）

Windows に依存しない。読み取りは Desktop（winsend.WinDesktop の読む部分だけ）に任せる。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

from .send import DIALOG_CLASS, FocusInfo, Keypath, WindowInfo


def shape(class_name: str, name: str) -> str:
    """値の形だけ。数字は桁数も出さない（店の金額の大きさを出さない）。"""
    if name == "":
        return "空"
    if class_name != "NumEdit":
        return "文字あり"
    if re.fullmatch(r"-?\d+", name):
        return "数字"
    if re.fullmatch(r"-?\d{1,3}(,\d{3})+", name):
        return "数字・カンマつき"
    m = re.fullmatch(r"-?[\d,]*\.(\d+)", name)
    if m:
        return f"小数点つき（小数 {len(m.group(1))} 桁）" + ("・カンマつき" if "," in name else "")
    return "そのほか"


def all_fields(kp_data: dict) -> list[dict]:
    rows = kp_data["rows"]
    br = rows["branch_after_担当"]
    out = list(rows["fields"]) + list(br["part"]["fields"]) + list(br["labor"]["fields"])
    if isinstance(br.get("not_on_path"), dict):
        out.append(br["not_on_path"])
    return out


@dataclass(frozen=True)
class Seen:
    field: str  # 明細1.項目CD / 伝票種別 / （keypath に無い位置）
    row: int | None
    name: str | None  # 項目CD など（行の欄のとき）
    class_name: str
    x: int
    y: int
    width: int
    shape: str


def locate(kp: Keypath, kp_data: dict, w: WindowInfo, f: FocusInfo) -> Seen:
    left, top = w.rect[0], w.rect[1]
    x, y = f.rect[0] - left, f.rect[1] - top
    width = f.rect[2] - f.rect[0]
    tol = kp.tolerance
    sh = shape(f.class_name, f.name)
    header = kp_data.get("header", {})
    for label, h in (("伝票種別", header.get("伝票種別")), ("走行距離", (header.get("to_first_row") or {}).get("start"))):
        if not isinstance(h, dict):
            continue
        if h.get("class") == f.class_name and abs(h["x"] - x) <= tol and abs(h["y"] - y) <= tol:
            return Seen(label, None, None, f.class_name, x, y, width, sh)
    dy = y - kp.first_row_y
    row = round(dy / kp.row_height) + 1
    if 1 <= row <= kp.visible_rows and abs(dy - (row - 1) * kp.row_height) <= tol:
        for fd in all_fields(kp_data):
            if fd.get("class") == f.class_name and abs(fd["x"] - x) <= tol:
                return Seen(f"明細{row}.{fd['field']}", row, fd["field"], f.class_name, x, y, width, sh)
    return Seen("（keypath に無い位置）", None, None, f.class_name, x, y, width, sh)


def expected_next(kp: Keypath, prev: Seen) -> set[str]:
    """keypath の順で、prev の次に来るはずの欄。部品と作業の分かれ目（担当の後）は両方を許す。"""
    order = [f["field"] for f in kp.path]
    if prev.row is None or prev.name not in order + ["点数", "技術料"]:
        return set()
    r = prev.row
    if prev.name == "担当":
        return {f"明細{r}.数量", f"明細{r}.点数"}
    if prev.name == "点数":
        return {f"明細{r}.技術料"}
    if prev.name in ("技術料", order[-1]):
        return {f"明細{r + 1}.{order[0]}"}
    i = order.index(prev.name)
    return {f"明細{r}.{order[i + 1]}"}


class Watcher:
    def __init__(self, desk, kp: Keypath, kp_data: dict, out: Callable[[dict], None]) -> None:
        self.desk = desk
        self.kp = kp
        self.kp_data = kp_data
        self.out = out
        self.last_key = None
        self.prev: Seen | None = None
        self.dialogs = 0
        self.counts = {"順どおり": 0, "順と違う": 0, "keypath に無い位置": 0}

    def _window_ok(self, w: WindowInfo | None) -> bool:
        return (w is not None and w.exe.lower() == self.kp.exe.lower() and w.class_name == self.kp.window_class
                and self.kp.title_contains in w.title)

    def step(self) -> None:
        dialogs = sum(1 for t in self.desk.visible_windows() if t.class_name == DIALOG_CLASS)
        if dialogs != self.dialogs:
            self.dialogs = dialogs
            self.out({"kind": "dialog", "count": dialogs})
        w = self.desk.foreground()
        if not self._window_ok(w):
            key = ("other",)
            if key != self.last_key:
                self.last_key = key
                self.out({"kind": "away", "exe": w.exe if w is not None else None})
                self.prev = None
            return
        f = self.desk.focused()
        if f is None or f.pid != w.pid:
            return
        s = locate(self.kp, self.kp_data, w, f)
        key = (s.field, s.class_name, s.x, s.y, s.width, s.shape)
        if key == self.last_key:
            return
        moved = self.last_key is None or self.last_key[:5] != key[:5]
        self.last_key = key
        if not moved:
            self.out({"kind": "value", "field": s.field, "shape": s.shape})
            return
        verdict = None
        if s.row is None and s.field.startswith("（"):
            self.counts["keypath に無い位置"] += 1
        if self.prev is not None:
            exp = expected_next(self.kp, self.prev)
            if exp:
                verdict = "順どおり" if s.field in exp else "順と違う"
                self.counts[verdict] += 1
        self.out({"kind": "focus", "field": s.field, "class": s.class_name, "x": s.x, "y": s.y, "width": s.width,
                  "shape": s.shape, "from": self.prev.field if self.prev else None, "verdict": verdict})
        self.prev = s


def line(e: dict) -> str:
    if e["kind"] == "focus":
        v = f"  [{e['verdict']}]" if e.get("verdict") else ""
        return f"{e['field']:14} {e['class']:8} ({e['x']}, {e['y']}) 幅 {e['width']}  値: {e['shape']}{v}"
    if e["kind"] == "value":
        return f"{e['field']:14} 値が変わった: {e['shape']}"
    if e["kind"] == "dialog":
        return f"ダイアログ・小窓（#32770）の数: {e['count']}"
    return f"伝票の画面の外（{e.get('exe')}）"
