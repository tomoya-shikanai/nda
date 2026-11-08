"""見積・請求書（納品書）の伝票の窓を開き、客と車を選び、明細 1 行目の項目CD まで進める（opener）。

道（openpath.json。各手順の前に、前面の窓・フォーカスの部品のクラスと位置を確かめる）:
1. M_NOU.EXE を、伝票の種類の引数で起動し、「[ 画面名 ] - RacroSⅢ」の窓が前面に出るのを待つ。
2. ツールバーを読み、ボタンの数・4 番目の id（103＝新規）・押せる状態・幅が合うときだけ、新規の真ん中を 1 回クリックする。
   クリックはこの 1 点だけ。
3. 顧客車両検索の窓で、番号の欄にナンバーの番号を打って Enter。一覧にフォーカスが移るのを待つ。
4. 一覧の行を読み（この PC の中の OCR）、ナンバーの番号の行がちょうど 1 つのときだけ、↓ でそこへ移って Enter。
5. 伝票の窓の題名が「[ 客の名前 ] - [ 画面名 ] - RacroSⅢ」とぴったり同じかを確かめる（客の名前は DB から引く）。
6. 伝票種別に種類の番号（見積 4・納品書 1）を打って Enter。読み返しが合わなければ止める。
7. フォーカスが明細 1 行目の項目CD に来るまで、Enter を 1 回ずつ確かめながら送る。
ここで止まり、明細の送信（inputter.send.run）に渡す。

守り: 人のキーボード・マウス、ダイアログ・止める小窓・知らない窓が出たら、何も押さずに止める。止まったら窓はそのまま。
保存・印刷・削除・中止は押さない。客の名前・ナンバーは出力に出さない。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from inputter.send import DIALOG_CLASS, FocusInfo, Stop, TopWindow, WindowInfo, _tick_after, name_usable

OPENPATH = Path(__file__).with_name("openpath.json")
KEYS = frozenset({"Enter", "Down", "PageUp"})
POLL_S = 0.1
WAIT_WINDOW_S = 30.0
WAIT_FOCUS_S = 5.0
STABLE_S = 0.5
OWN_INPUT_MARGIN_MS = 100


class OpenDesktop(Protocol):
    def foreground(self) -> WindowInfo | None: ...
    def focused(self) -> FocusInfo | None: ...
    def visible_windows(self) -> list[TopWindow]: ...
    def last_input_tick(self) -> int: ...
    def tick_now(self) -> int: ...
    def cursor_pos(self) -> tuple[int, int]: ...
    def keys_held(self) -> bool: ...
    def human_input_seen(self) -> bool: ...
    def reset_human_input(self) -> None: ...
    def send_key(self, name: str) -> None: ...
    def send_char(self, ch: str) -> None: ...
    def sleep(self, seconds: float) -> None: ...
    # opener だけが使うもの
    def launch(self, exe_path: str, args: list[str], cwd: str) -> int: ...  # 起動した pid
    def toolbar_buttons(self, hwnd: int, class_name: str) -> list[tuple[int, int, tuple[int, int, int, int]]]: ...  # (id, state, 画面の rect)
    def click(self, x: int, y: int) -> None: ...  # 左クリック 1 回
    def read_rows(self, rect: tuple[int, int, int, int]) -> list[str]: ...  # 一覧の画面の文字を、行ごとに（PC の中の OCR）


@dataclass(frozen=True)
class Target:
    vehicle_no: int  # ナンバーの番号（1〜9999）
    customer_name: str  # 題名に出る客の名前（KOK_NAMEJ1）。lookup で引いたもの
    kind: str  # "estimate" | "invoice"
    plate_bango: str  # ナンバーの分類（例 500）。一覧の行の照合に使う
    plate_kana: str  # ナンバーのかな（ひらがな 1 文字）
    list_rows: int  # 番号で探したときに一覧に出るはずの車の数（DB で数えた、削除されていない車）


def load_openpath(data: object) -> dict:
    if not isinstance(data, dict) or not isinstance(data.get("kinds"), dict):
        raise Stop("openpath.json の形が違う")
    for k in ("exe", "exe_path", "cwd", "title_tail"):
        if not isinstance(data.get(k), str) or not data[k]:
            raise Stop(f"openpath.json の {k} が無い")
    return data


class Opener:
    def __init__(self, desk: OpenDesktop, path: dict, log: Callable[[str], None]):
        self.desk, self.p, self.log = desk, load_openpath(path), log
        self.tol = int(self.p.get("position_tolerance_px", 3))
        self.pid: int | None = None
        self.tick = 0
        self.cursor = (0, 0)

    # -- 確かめ --

    def _check_input(self) -> None:
        if self.desk.human_input_seen():
            raise Stop("人がキーボードかマウスを触った")
        if self.desk.keys_held():
            raise Stop("修飾キーかマウスのボタンが押されている")
        last = self.desk.last_input_tick()
        if _tick_after(last, self.tick) > 0:
            raise Stop("人がキーボードかマウスを触った")
        if self.desk.cursor_pos() != self.cursor:
            raise Stop("マウスが動いた")

    def _check_dialogs(self, allow_titles: tuple[str, ...] = ()) -> None:
        for w in self.desk.visible_windows():
            if w.class_name == DIALOG_CLASS:
                raise Stop("ダイアログが出ている")
            if w.title not in allow_titles and any(s in w.title for s in self.p.get("stop_titles", [])):
                raise Stop("止める小窓が出ている")

    def _fg(self) -> WindowInfo | None:
        try:
            return self.desk.foreground()
        except Exception as ex:
            raise Stop(f"前面の窓を読めなかった（{type(ex).__name__}）") from None

    def _rel_ok(self, w: WindowInfo, f: FocusInfo | None, spec: dict) -> bool:
        if f is None or f.pid != w.pid or f.class_name != spec["class"]:
            return False
        if abs((f.rect[0] - w.rect[0]) - spec["x"]) > self.tol or abs((f.rect[1] - w.rect[1]) - spec["y"]) > self.tol:
            return False
        width = spec.get("width")
        return width is None or abs((f.rect[2] - f.rect[0]) - width) <= self.tol

    def _wait(self, ok: Callable[[], object], what: str, timeout: float, stable: float = STABLE_S):
        waited, held = 0.0, 0.0
        while True:
            self._check_input()
            self._check_dialogs()  # 待つ間に出て消えるダイアログも見逃さない（Codex の指摘）
            got = ok()
            if got:
                if held >= stable:
                    return got
                held += POLL_S
            else:
                held = 0.0
            if waited >= timeout:
                raise Stop(f"{what} を待ったが来ない")
            self.desk.sleep(POLL_S)
            waited += POLL_S

    def _send(self, fn: Callable[[], None], guard: Callable[[], str | None]) -> None:
        """送る直前に、人の入力・ダイアログ・前面の窓とフォーカス（guard）を確かめてから 1 つだけ送る（Codex の指摘）。"""
        self._check_input()
        self._check_dialogs()
        problem = guard()
        if problem:
            raise Stop(problem)
        self._check_input()  # 確かめの間に人が触っていないかを、送る直前にもう一度（Codex の指摘）
        sent_at = self.desk.tick_now()
        fn()
        self.desk.sleep(0.15)
        last = self.desk.last_input_tick()
        if _tick_after(last, sent_at) > OWN_INPUT_MARGIN_MS:
            raise Stop("送った後に、人がキーボードかマウスを触った")
        self.tick = last
        self.cursor = self.desk.cursor_pos()

    def _key(self, name: str, guard: Callable[[], str | None]) -> None:
        if name not in KEYS:
            raise Stop(f"送ってよいキーでない: {name!r}")
        self._send(lambda: self.desk.send_key(name), guard)

    def _digits(self, text: str, guard: Callable[[], str | None]) -> None:
        if not text.isdigit() or not text.isascii():
            raise Stop("数字でない文字を打とうとした")
        for ch in text:
            self._send(lambda ch=ch: self.desk.send_char(ch), guard)

    def _at(self, title: str, w: WindowInfo, spec: dict | None, what: str) -> Callable[[], str | None]:
        """前面の窓が w（同じ hwnd・pid・題名）で、フォーカスが spec の欄にあるか。合わなければ理由を返す。"""
        def guard():
            fg = self._fg()
            if fg is None or fg.hwnd != w.hwnd or fg.pid != w.pid or fg.title != title:
                return f"{what}: 前面の窓が変わった"
            if spec is not None and not self._rel_ok(fg, self.desk.focused(), spec):
                return f"{what}: フォーカスが決まった欄にない"
            return None
        return guard

    # -- 道 --

    def _title(self, screen: str, name: str | None = None) -> str:
        tail = self.p["title_tail"]
        return f"[ {name} ] - [ {screen} ] - {tail}" if name else f"[ {screen} ] - {tail}"

    def run(self, t: Target) -> WindowInfo:
        kind = self.p["kinds"].get(t.kind)
        if not isinstance(kind, dict):
            raise Stop("伝票の種類が openpath.json に無い")
        if not name_usable(t.customer_name) or not 0 < t.vehicle_no <= 9999:
            raise Stop("客の名前かナンバーの番号が使えない形")
        screen, densyu = kind["screen"], int(kind["densyu"])
        slip_title = self._title(screen, t.customer_name)
        # 同じ客の伝票の窓がもう開いていれば、2 つの窓で同じ伝票を開かないよう止める
        if any(w.title == slip_title for w in self.desk.visible_windows()):
            raise Stop("同じ客の伝票の窓がもう開いている")
        self._check_dialogs()
        self.desk.reset_human_input()
        self.tick = self.desk.last_input_tick()
        self.cursor = self.desk.cursor_pos()

        # 1. 起動して、空の伝票の窓が前面に出るのを待つ
        self.pid = self.desk.launch(self.p["exe_path"], list(kind["args"]), self.p["cwd"])
        self.tick = self.desk.last_input_tick()
        empty_title = self._title(screen)

        def our(title: str):
            w = self._fg()
            return w if (w and w.pid == self.pid and w.class_name == "ThunderRT6FormDC" and w.title == title
                         and w.exe.lower() == self.p["exe"].lower()) else None

        w = self._wait(lambda: our(empty_title), "伝票の窓", WAIT_WINDOW_S)
        self._check_dialogs()
        self.log("伝票の窓が開いた。")

        # 2. ツールバーの新規を確かめて、1 回だけクリック
        tb = self.p["toolbar"]
        buttons = self.desk.toolbar_buttons(w.hwnd, tb["class"])
        if len(buttons) != tb["count"]:
            raise Stop("ツールバーのボタンの数が記録と違う")
        bid, state, r = buttons[tb["new_index"]]
        if bid != tb["new_id"] or not state & 0x4 or abs((r[2] - r[0]) - tb["button_width"]) > self.tol:
            raise Stop("新規のボタンが記録と違うか、押せない状態")
        if not (w.rect[0] <= r[0] and r[2] <= w.rect[2] and w.rect[1] <= r[1] and r[3] <= w.rect[3]):
            raise Stop("新規のボタンが窓の外にある")
        def click_guard():
            # クリックの直前に、窓の位置とボタンを読み直し、確かめたときと同じかを見る（Codex の指摘）
            again = self.desk.toolbar_buttons(w.hwnd, tb["class"])
            if len(again) != len(buttons) or again[tb["new_index"]] != buttons[tb["new_index"]]:
                return "クリックの直前に、ツールバーが変わった"
            now = our(empty_title)  # ツールバーを読んだ後に、窓の位置を読む（読む間に動いても見つける）
            if now is None or now.hwnd != w.hwnd or now.rect != w.rect:
                return "クリックの直前に、前面の窓か位置が変わった"
            return None
        self._send(lambda: self.desk.click((r[0] + r[2]) // 2, (r[1] + r[3]) // 2), click_guard)
        self.cursor = self.desk.cursor_pos()  # クリックで動いたマウスの位置を、ここからの基準にする
        self.log("新規を押した。")

        # 3. 顧客車両検索で、番号を打って Enter
        sp = self.p["search"]
        s = self._wait(lambda: our(sp["title"]), "顧客車両検索の窓", WAIT_WINDOW_S)
        self._wait(lambda: self._rel_ok(s, self.desk.focused(), sp["number"]), "番号の欄のフォーカス", WAIT_FOCUS_S)
        f = self.desk.focused()
        if f.name.strip() not in ("", "0"):
            raise Stop("番号の欄が空でない")
        at_number = self._at(sp["title"], s, sp["number"], "番号の欄")
        self._digits(str(t.vehicle_no), at_number)
        self._wait(lambda: (self.desk.focused().name.strip() == str(t.vehicle_no)), "番号の読み返し", WAIT_FOCUS_S, 0)
        self._key("Enter", at_number)
        self._wait(lambda: our(sp["title"]) and self._rel_ok(s, self.desk.focused(), sp["list"]), "一覧のフォーカス", WAIT_FOCUS_S)
        at_list = self._at(sp["title"], s, sp["list"], "一覧")

        # 4. 一覧の行を読み、ナンバーの番号の行がちょうど 1 つのときだけ、そこへ移って Enter
        lr = self.desk.focused().rect
        rows = self.desk.read_rows(lr)
        if not rows:
            raise Stop("一覧の行を読めない")
        # 数字のある行だけを車の行とみる（見出しの行は数えない）。その数が DB で数えた台数と違えば、
        # 読み落としか見出しの数え違いなので止める（Codex の指摘）
        data = [r for r in rows if re.search(r"\d", r)]
        if len(data) != t.list_rows:
            raise Stop(f"一覧の車の行の数が、DB の台数と合わない（読めた {len(data)} 行）")
        no = str(t.vehicle_no)
        # ナンバーの分類・かな・番号のすべてがある行だけ（顧客コードなどほかの列の数字では選ばない。Codex の指摘）
        # 分類・かな・番号が続けて並ぶ（「500 あ 7319」）行だけ。ばらばらの列の数字では選ばない
        plate = re.compile(rf"(?<!\d){re.escape(t.plate_bango)}\s*{re.escape(t.plate_kana)}\s*{no}(?!\d)")
        hits = [i for i, text in enumerate(data) if plate.search(text)]
        if len(hits) != 1:
            raise Stop(f"一覧でナンバーの合う行が 1 つに決まらない（{len(hits)} 行）")
        # 最初にどの行が選ばれているかは分からないので、PageUp で先頭の行に戻してから数える（Codex の指摘。実機で確かめる）
        for _ in range(2):
            self._key("PageUp", at_list)
        for _ in range(hits[0]):
            self._key("Down", at_list)
        self._key("Enter", at_list)

        # 5. 伝票の窓の題名で、客を確かめる
        w = self._wait(lambda: our(slip_title), "客の入った伝票の窓", WAIT_WINDOW_S)
        self._check_dialogs()
        self.log("客と車が伝票に入った（題名で確かめた）。")

        # 6. 伝票種別
        sl = self.p["slip"]
        self._wait(lambda: our(slip_title) and self._rel_ok(w, self.desk.focused(), sl["densyu"]), "伝票種別の欄", WAIT_FOCUS_S)
        at_densyu = self._at(slip_title, w, sl["densyu"], "伝票種別")
        if self.desk.focused().name.strip() != str(densyu):
            self._digits(str(densyu), at_densyu)
            self._wait(lambda: self.desk.focused().name.strip() == str(densyu), "伝票種別の読み返し", WAIT_FOCUS_S, 0)
        self._key("Enter", at_densyu)

        # 7. 明細 1 行目の項目CD まで、Enter を 1 回ずつ。見出しの欄（明細の行より上）で、同じ欄に 2 回来ないときだけ（Codex の指摘）
        seen: set[tuple[int, int]] = set()

        def in_header():
            fg, f = self._fg(), self.desk.focused()
            if fg is None or fg.hwnd != w.hwnd or fg.title != slip_title or f is None or f.pid != w.pid:
                return None
            if f.class_name not in ("NumEdit", "TextEdit"):
                return None
            return (f.rect[0] - w.rect[0], f.rect[1] - w.rect[1])

        for _ in range(int(sl["max_enters"]) + 1):  # 最後の Enter の後にも、明細 1 行目に来たかを確かめる（Codex の指摘）
            pos = self._wait(in_header, "見出しの欄", WAIT_FOCUS_S)
            if self._rel_ok(w, self.desk.focused(), sl["first_row"]):
                self.log("明細 1 行目の項目CD に来た。ここから明細を入れる。")
                return w
            if pos[1] >= sl["first_row"]["y"] - self.tol or pos in seen:
                raise Stop("見出しの欄でない所か、同じ欄にフォーカスが来た")
            if len(seen) >= int(sl["max_enters"]):
                break
            seen.add(pos)

            def here(pos=pos):
                now = in_header()
                return None if now == pos else "見出しの欄: フォーカスが変わった"
            self._key("Enter", here)
        raise Stop("Enter を決まった回数送っても、明細 1 行目に来ない")


def run(desk: OpenDesktop, t: Target, log: Callable[[str], None], path: dict | None = None) -> WindowInfo:
    return Opener(desk, path if path is not None else json.loads(OPENPATH.read_text(encoding="utf-8")), log).run(t)
