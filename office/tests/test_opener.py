"""opener（伝票の窓を開いて客を選ぶ）の試験。偽の画面だけを使い、本物の窓には何も送らない。"""

import json
import unittest

from inputter.send import FocusInfo, Stop, TopWindow, WindowInfo
from opener.open import OPENPATH, Opener, Target

PATH = json.loads(OPENPATH.read_text(encoding="utf-8"))
NAME = "架空　太郎"
SLIP = f"[ {NAME} ] - [ 整備見積･指示書発行 ] - RacroSⅢ"
EMPTY = "[ 整備見積･指示書発行 ] - RacroSⅢ"
SEARCH = "[ 顧客車両検索 ] - RacroSⅢ"


class FakeScreen:
    """M_NOU の偽物。起動 → 空の伝票 → 新規で顧客車両検索 → 番号・Enter で一覧 → ↓・Enter で客の伝票 → 種別 → Enter で明細へ。"""

    def __init__(self, rows=("架空 500 さ 1234 架空", "架空 500 あ 7319 架空")):
        self.now = 1_000_000
        self.last = self.now - 10_000
        self.cur = (10, 10)
        self.human = False
        self.sent = []
        self.state = "none"
        self.rows = list(rows)
        self.row = 1  # 検索の後に、先頭でない行が選ばれていることもある（PageUp で先頭に戻す）
        self.name = ""
        self.enters = 0
        self.slip_rect = (192, 0, 1728, 1075)
        self.search_rect = (220, 0, 1479, 1087)
        self.buttons = [(100 + i, 0x4 if i != 2 else 0x0, (196 + 55 * i, 90, 251 + 55 * i, 144)) for i in range(23)]
        self.selected_title = SLIP
        self.extra = []
        self.typed = False

    # 読む
    def foreground(self):
        if self.state == "none":
            return None
        t = {"empty": EMPTY, "search": SEARCH, "list": SEARCH}.get(self.state, self.selected_title)
        r = self.search_rect if self.state in ("search", "list") else self.slip_rect
        return WindowInfo(hwnd=5, pid=77, exe="M_NOU.exe", class_name="ThunderRT6FormDC", title=t, rect=r)

    def _f(self, rel, cls, w, r):
        x, y = r[0] + rel[0], r[1] + rel[1]
        return FocusInfo(pid=77, class_name=cls, rect=(x, y, x + w, y + 30), name=self.name)

    def focused(self):
        if self.state == "search":
            return self._f((946, 149), "NumEdit", 63, self.search_rect)
        if self.state == "list":
            return self._f((4, 435), "VSFlexGridL", 1471, self.search_rect)
        if self.state == "densyu":
            return self._f((874, 321), "NumEdit", 33, self.slip_rect)
        if self.state == "header":
            return self._f((1030, 351 + 30 * self.enters), "NumEdit", 50, self.slip_rect)
        if self.state == "row1":
            return self._f((53, 566), "NumEdit", 72, self.slip_rect)
        return None

    def visible_windows(self):
        w = self.foreground()
        return ([TopWindow(hwnd=5, class_name="ThunderRT6FormDC", title=w.title)] if w else []) + self.extra

    def last_input_tick(self):
        return self.last & 0xFFFFFFFF

    def tick_now(self):
        return self.now & 0xFFFFFFFF

    def cursor_pos(self):
        return self.cur

    def keys_held(self):
        return False

    def human_input_seen(self):
        return self.human

    def reset_human_input(self):
        self.human = False

    def sleep(self, s):
        self.now += int(s * 1000)

    def _input(self):
        self.now += 2
        self.last = self.now

    # 送る
    def launch(self, exe, args, cwd):
        self.sent.append(("launch", tuple(args)))
        self.state = "empty"
        return 77

    def toolbar_buttons(self, hwnd, cls):
        return self.buttons

    def click(self, x, y):
        self.sent.append(("click", x, y))
        self._input()
        self.cur = (x, y)
        if self.state == "empty" and 196 + 165 <= x <= 196 + 220:
            self.state, self.name = "search", "0"

    def read_rows(self, rect):
        return self.rows

    def send_char(self, ch):
        self.sent.append(("char", ch))
        self._input()
        # 数の欄は、フォーカスが来た直後の最初の文字で中身を置き換える（11/7: 種別の 1 に 4 を打って 4 になった）
        first = not self.typed
        self.typed = True
        self.name = ch if first else self.name + ch

    def send_key(self, k):
        self.sent.append(("key", k))
        self._input()
        self.typed = False
        if k == "PageUp" and self.state == "list":
            self.row = 0
        elif k == "Down" and self.state == "list":
            self.row += 1
        elif k == "Enter":
            if self.state == "search":
                self.state, self.name = "list", ""
            elif self.state == "list":
                self.state, self.name = "densyu", "1"
            elif self.state == "densyu":
                self.state, self.name = "header", ""
            elif self.state == "header":
                self.enters += 1
                if self.enters >= 3:
                    self.state = "row1"


def run(screen, kind="estimate", no=7319, name=NAME, rows=2):
    log = []
    w = Opener(screen, PATH, log.append).run(Target(vehicle_no=no, customer_name=name, kind=kind, plate_bango="500",
                                                    plate_kana="あ", list_rows=rows))
    return w, log


class OpenerTest(unittest.TestCase):
    def test_happy_path(self):
        s = FakeScreen()
        w, log = run(s)
        self.assertEqual(w.title, SLIP)
        self.assertEqual(s.state, "row1")
        clicks = [x for x in s.sent if x[0] == "click"]
        self.assertEqual(len(clicks), 1)  # クリックは新規の 1 回だけ
        self.assertEqual(s.row, 1)  # PageUp で先頭に戻し、2 行目（7319）へ ↓ 1 回
        self.assertEqual([x for x in s.sent if x[0] == "key" and x[1] in ("PageUp", "Down")],
                         [("key", "PageUp"), ("key", "PageUp"), ("key", "Down")])
        self.assertIn(("char", "4"), s.sent)  # 見積は種別 4
        self.assertNotIn(NAME, "\n".join(log))
        self.assertNotIn("7319", "\n".join(log))

    def test_invoice_kind_keeps_densyu_1(self):
        s = FakeScreen()
        s.selected_title = f"[ {NAME} ] - [ 整備伝票発行 ] - RacroSⅢ"
        empty = "[ 整備伝票発行 ] - RacroSⅢ"
        orig = s.foreground

        def fg():
            w = orig()
            return w if w is None or s.state != "empty" else WindowInfo(**{**w.__dict__, "title": empty})
        s.foreground = fg
        run(s, kind="invoice")
        self.assertEqual(s.state, "row1")
        self.assertNotIn(("char", "4"), s.sent)  # 納品書は種別 1 のまま（もう 1 なので打たない）
        self.assertIn(("launch", ("010100", "1")), s.sent)

    def test_wrong_toolbar_never_clicks(self):
        for change in ("count", "id", "disabled"):
            with self.subTest(change=change):
                s = FakeScreen()
                if change == "count":
                    s.buttons = s.buttons[:22]
                elif change == "id":
                    s.buttons[3] = (999,) + s.buttons[3][1:]
                else:
                    s.buttons[3] = (103, 0x0, s.buttons[3][2])
                with self.assertRaises(Stop):
                    run(s)
                self.assertFalse([x for x in s.sent if x[0] == "click"])

    def test_ambiguous_or_missing_row_stops_before_enter(self):
        cases = (
            (("架空 500 あ 7319 甲", "架空 500 あ 7319 乙"), 2),  # 同じナンバーの行が 2 つ
            (("架空 500 さ 7319", "架空 500 あ 1234"), 2),  # ナンバーの合う行が無い
            (("顧客 7319 架空 500 あ 1234", "架空 500 さ 9999"), 2),  # 番号がほかの列にあるだけ
            (("架空 500 あ 7319",), 2),  # 読めた行の数が DB の台数と合わない（読み落とし）
            ((), 2),
        )
        for rows, n in cases:
            with self.subTest(rows=rows):
                s = FakeScreen(rows=rows)
                with self.assertRaises(Stop):
                    run(s, rows=n)
                self.assertEqual(s.state, "list")  # 一覧の上で止まり、客を選ばない

    def test_header_row_is_not_counted(self):
        s = FakeScreen(rows=("顧客 名前 ナンバー", "架空 500 さ 1234 架空", "架空 500 あ 7319 架空"))
        run(s)
        self.assertEqual(s.row, 1)  # 見出しの行は数えず、2 行目のデータ行へ ↓ 1 回

    def test_focus_moved_during_typing_stops(self):
        s = FakeScreen()
        orig = s.send_char

        def send_char(ch):
            orig(ch)
            if s.sent.count(("char", "3")) == 1:
                s.state = "header"  # 番号を打っている途中でフォーカスが別の欄へ
        s.send_char = send_char
        with self.assertRaises(Stop):
            run(s)
        self.assertNotIn(("char", "1"), s.sent)

    def test_window_moved_before_click_stops(self):
        s = FakeScreen()
        calls = []
        orig = s.toolbar_buttons

        def tb(h, c):
            calls.append(1)
            if len(calls) == 2:
                s.slip_rect = (300, 0, 1836, 1075)
            return orig(h, c)
        s.toolbar_buttons = tb
        with self.assertRaises(Stop):
            run(s)
        self.assertFalse([x for x in s.sent if x[0] == "click"])

    def test_wrong_customer_title_stops(self):
        s = FakeScreen()
        s.selected_title = "[ 別の客 ] - [ 整備見積･指示書発行 ] - RacroSⅢ"
        with self.assertRaises(Stop):
            run(s)
        self.assertNotIn(("char", "4"), s.sent)  # 種別を打つ前に止まる

    def test_same_customer_already_open_stops_before_launch(self):
        s = FakeScreen()
        s.extra = [TopWindow(hwnd=9, class_name="ThunderRT6FormDC", title=SLIP)]
        with self.assertRaises(Stop):
            run(s)
        self.assertEqual(s.sent, [])

    def test_human_input_stops(self):
        s = FakeScreen()
        orig = s.click

        def click(x, y):
            orig(x, y)
            s.human = True
        s.click = click
        with self.assertRaises(Stop):
            run(s)
        self.assertEqual([x[0] for x in s.sent], ["launch", "click"])

    def test_dialog_while_waiting_stops(self):
        s = FakeScreen()
        orig = s.launch

        def launch(*a):
            pid = orig(*a)
            s.extra = [TopWindow(hwnd=9, class_name="#32770", title="")]  # 起動の直後にダイアログ
            return pid
        s.launch = launch
        with self.assertRaises(Stop):
            run(s)
        self.assertFalse([x for x in s.sent if x[0] == "click"])

    def test_dialog_stops(self):
        s = FakeScreen()
        s.extra = [TopWindow(hwnd=9, class_name="#32770", title="伝票発行")]
        with self.assertRaises(Stop):
            run(s)
        self.assertEqual(s.sent, [])

    def test_bad_target_refused(self):
        for no, name in ((0, NAME), (10000, NAME), (7319, " 架空"), (7319, "x")):
            with self.subTest(no=no, name=name), self.assertRaises(Stop):
                run(FakeScreen(), no=no, name=name)

    def test_openpath_unconfirmed(self):
        self.assertIs(PATH["confirmed"], False)


if __name__ == "__main__":
    unittest.main()
