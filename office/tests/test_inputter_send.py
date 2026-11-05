"""inputter/send.py の試験。架空の窓（偽の部品）だけを使い、本物の窓には何も送らない。"""

import copy
import json
import sys
import unittest
from decimal import Decimal

from inputter import send
from inputter.plan import COLUMNS_PATH, build_plan, load_json
from inputter.send import FocusInfo, Stop, TopWindow, WindowInfo

KEYPATH = load_json(send.KEYPATH_PATH)
COLUMNS = load_json(COLUMNS_PATH)
ITEMS = {"items": {"架空の部品A": 101, "架空の部品B": 2345, "架空の自由入力": 0}}
WIN_LEFT, WIN_TOP = 192, 0


def job(*lines):
    return {"job_id": "test-1", "customer_code": 9001, "car_code": 9002, "lines": list(lines)}


LINE_A = {"item": "架空の部品A", "qty": 4, "unit": "本", "unitPrice": 7777}
LINE_B = {"item": "架空の部品B", "qty": Decimal("1.5"), "unit": "L", "unitPrice": 1234}


def kp(data=None):
    return send.load_keypath(KEYPATH if data is None else data)


def groups_for(*lines):
    return send.prepare(build_plan(job(*lines), ITEMS, COLUMNS), kp())


class FakeDesktop:
    """伝票の画面の偽物。Enter で keypath の順に次の欄へ進み、文字は今の欄の Name に足される。"""

    def __init__(self, k, rows=15):
        self.k = k
        self.window = WindowInfo(hwnd=100, pid=7, exe="M_NOU.exe", class_name="ThunderRT6FormDC",
                                 title="[ 架空 ] - [ 整備伝票発行 ] - RacroSⅢ", rect=(WIN_LEFT, WIN_TOP, 1728, 1040))
        self.fields = []  # (row, keypath の欄)
        for r in range(1, rows + 2):
            for f in k.path:
                self.fields.append((r, f))
        self.names = {}
        self.pos = 0  # フォーカスのある欄
        self.now = 1_000_000
        self.last_input = self.now - 10_000  # 始める前は人が触っていない
        self.cursor = (500, 500)
        self.held = False
        self.extra_windows = []
        self.sent = []  # 送ったもの（("key", "Enter") / ("char", "1")）
        self.master = True  # 項目CD の Enter で作業内容に名前が入る
        self.hooks = []  # 送るたびに呼ぶ（偽の不具合を起こす）
        self.focus_override = None
        self.drop_chars = False
        self.human_flag = False  # 低水準のフックで、injected でない入力を見た
        self.delayed = []  # (出る時刻, TopWindow)。遅れて出る小窓
        self.format = None  # Name の見え方を変える関数

    # -- Desktop --
    def foreground(self):
        return self.window

    def _rect(self, row, f):
        x = WIN_LEFT + f["x"]
        y = WIN_TOP + self.k.first_row_y + (row - 1) * self.k.row_height
        return (x, y, x + (f.get("width") or 10), y + 20)

    def focused(self):
        if self.focus_override == "none":
            return None
        if self.focus_override is not None:
            return self.focus_override
        row, f = self.fields[self.pos]
        name = self.names.get(self.pos, "")
        if self.format:
            name = self.format(f, name)
        return FocusInfo(pid=7, class_name=f["class"], rect=self._rect(row, f), name=name)

    def windows_of(self, pid):
        late = [w for at, w in self.delayed if at <= self.now]
        return [TopWindow(hwnd=100, class_name="ThunderRT6FormDC", title=self.window.title)] + self.extra_windows + late

    def human_input_seen(self):
        return self.human_flag

    def reset_human_input(self):
        self.human_flag = False

    def last_input_tick(self):
        return self.last_input & 0xFFFFFFFF

    def tick_now(self):
        return self.now & 0xFFFFFFFF

    def cursor_pos(self):
        return self.cursor

    def keys_held(self):
        return self.held

    def _input(self):
        self.now += 2
        self.last_input = self.now

    def send_key(self, name):
        assert name in send.SEND_KEYS
        self.sent.append(("key", name))
        self._input()
        if name == "Enter":
            row, f = self.fields[self.pos]
            if f["field"] == "項目CD" and self.master and self.names.get(self.pos):
                self.names[self.pos + 1] = "架空の名前"
            self.pos += 1
        for h in list(self.hooks):
            h(self)

    def send_char(self, ch):
        self.sent.append(("char", ch))
        self._input()
        if not self.drop_chars:
            self.names[self.pos] = self.names.get(self.pos, "") + ch
        for h in list(self.hooks):
            h(self)

    def sleep(self, s):
        self.now += int(s * 1000)

    def human(self):
        self.now += 1
        self.last_input = self.now


def run(desk, groups, k=None):
    log = []
    send.run(desk, k or kp(), groups, log.append)
    return log


class KeypathTest(unittest.TestCase):
    def test_repo_keypath_loads_and_is_unconfirmed(self):
        k = kp()
        self.assertFalse(k.confirmed)
        self.assertEqual([f["field"] for f in k.path], ["項目CD", "作業内容", "作業区分", "担当", "数量", "単価"])
        self.assertEqual(k.tolerance, 3)

    def test_bad_keypath_refused(self):
        for mutate in (
            lambda d: d.__setitem__("advance_key", "F8"),
            lambda d: d["rows"]["row_end"].__setitem__("steps", [{"action": "key", "value": "Down"}]),
            lambda d: d["rows"]["fields"][0].__setitem__("class", "msvb_lib_toolbar"),
            lambda d: d["screen"].__setitem__("position_tolerance_px", 50),
            lambda d: d["rows"].__setitem__("visible_rows", True),
        ):
            d = copy.deepcopy(KEYPATH)
            mutate(d)
            with self.subTest(), self.assertRaises(send.SendError):
                kp(d)


class PrepareTest(unittest.TestCase):
    def test_targets_follow_rows(self):
        g = groups_for(LINE_A, LINE_B)
        self.assertEqual(len(g), 12)
        self.assertEqual((g[0].target.field, g[0].target.x, g[0].target.y, g[0].text), ("明細1.項目CD", 53, 566, "101"))
        self.assertEqual((g[6].target.field, g[6].target.y), ("明細2.項目CD", 591))
        self.assertEqual(g[10].text, "1.5")
        self.assertTrue(all(x.key == "Enter" for x in g))
        self.assertIsNone(g[1].text)  # 作業内容は打たない（マスタの名前）
        self.assertTrue(g[1].target.require_nonempty)

    def test_free_entry_row_refused(self):
        with self.assertRaisesRegex(send.SendError, "打つ欄なのに|自由入力"):
            groups_for({"item": "架空の自由入力", "qty": 1, "unit": "本", "unitPrice": 100})

    def test_more_than_visible_rows_refused(self):
        with self.assertRaisesRegex(send.SendError, "15 行"):
            groups_for(*([LINE_A] * 16))

    def test_hand_made_steps_refused(self):
        good = build_plan(job(LINE_A), ITEMS, COLUMNS)
        cases = {
            "Tab に変える": lambda s: s[1].__setitem__("value", "Tab"),
            "欄の順を入れ替える": lambda s: s.__setitem__(slice(0, 3), [s[2], s[0], s[1]]),
            "数の欄に文字": lambda s: s[0].__setitem__("value", "1a"),
            "項目CD に小数点": lambda s: s[0].__setitem__("value", "1.0"),
            "数量に小数 2 桁": lambda s: s[-4].__setitem__("value", "1.25"),
            "余計なキー": lambda s: s.insert(2, {"field": "明細1.項目CD", "action": "key", "value": "Enter"}),
            "余計な項目": lambda s: s[0].__setitem__("x", 10),
            "作業区分に打つ": lambda s: s.insert(3, {"field": "明細1.作業区分", "action": "type", "value": "1"}),
            "作業内容に打つ": lambda s: s.insert(2, {"field": "明細1.作業内容", "action": "type", "value": "abc"}),
            "行の途中で終わる": lambda s: s.pop(),
        }
        for name, mutate in cases.items():
            s = copy.deepcopy(good)
            mutate(s)
            with self.subTest(name), self.assertRaises(send.SendError):
                send.prepare(s, kp())

    def test_dry_run_lines_mask_values(self):
        lines = send.dry_run_lines(groups_for(LINE_A), kp())
        text = "\n".join(lines)
        self.assertNotIn("7777", text)
        self.assertIn("***(4 文字)", text)
        self.assertIn("NumEdit (53, 566) ±3", text)
        self.assertIn("(53, 591)", text)  # 入れ終えた後の確かめ


class ReadbackTest(unittest.TestCase):
    def t(self, source):
        return send.Target("x", "NumEdit", 0, 0, None, source, False, False)

    def test_number_forms(self):
        ok = [("unit_price", "1000", "1,000"), ("unit_price", "1000", "1000"), ("qty", "4", "4.0"),
              ("qty", "1.5", "1.50"), ("code", "101", " 101 "), ("unit_price", "1234567", "1,234,567")]
        bad = [("unit_price", "1000", "1,00"), ("unit_price", "1000", "100"), ("qty", "1.2", "1.25"),
               ("code", "101", "１０１"), ("unit_price", "1000", "1000.5"), ("unit_price", "1000", "\\1,000"),
               ("code", "101", ""), ("qty", "4", "-4"), ("unit_price", "1000", "1,0000")]
        for src, sent, name in ok:
            with self.subTest(name=name):
                self.assertTrue(send.readback_matches(self.t(src), sent, name))
        for src, sent, name in bad:
            with self.subTest(name=name):
                self.assertFalse(send.readback_matches(self.t(src), sent, name))

    def test_text_exact(self):
        t = send.Target("x", "TextEdit", 0, 0, None, "name", True, True)
        self.assertTrue(send.readback_matches(t, "abc", "abc"))
        self.assertFalse(send.readback_matches(t, "abc", "abc "))


class RunTest(unittest.TestCase):
    def setUp(self):
        self.k = kp()
        self.desk = FakeDesktop(self.k)

    def test_happy_path_sends_only_allowed(self):
        log = run(self.desk, groups_for(LINE_A, LINE_B))
        expected = []
        for code, qty, price in (("101", "4", "7777"), ("2345", "1.5", "1234")):
            expected += [("char", c) for c in code] + [("key", "Enter")] * 4
            expected += [("char", c) for c in qty] + [("key", "Enter")]
            expected += [("char", c) for c in price] + [("key", "Enter")]
        self.assertEqual(self.desk.sent, expected)
        self.assertIn("保存は人が押して", log[-1])
        joined = "\n".join(log)
        for v in ("7777", "2345", "1234", "1.5"):
            self.assertNotIn(v, joined)

    def test_comma_in_readback_passes(self):
        self.desk.format = lambda f, name: f"{int(name):,}" if name.isdigit() and f["field"] == "単価" else name
        run(self.desk, groups_for(LINE_A))
        self.assertEqual(self.desk.sent[-1], ("key", "Enter"))

    def assertStops(self, pattern, groups=None, sent_max=None):
        groups = groups or groups_for(LINE_A, LINE_B)
        with self.assertRaisesRegex(Stop, pattern) as cm:
            run(self.desk, groups)
        self.assertNotIn("7777", str(cm.exception))
        if sent_max is not None:
            self.assertLessEqual(len(self.desk.sent), sent_max)
        return cm.exception

    def test_wrong_foreground_never_sends(self):
        for change in (
            {"exe": "notepad.exe"},
            {"class_name": "#32770"},
            {"title": "[ 架空 ] - [ 顧客・車両 ] - RacroSⅢ"},
            {"class_name": "Edit"},
        ):
            self.desk = FakeDesktop(self.k)
            self.desk.window = WindowInfo(**{**self.desk.window.__dict__, **change})
            with self.subTest(change=change):
                self.assertStops("来ない", sent_max=0)

    def test_start_needs_first_field_and_quiet(self):
        self.desk.pos = 1  # 作業内容にフォーカス
        self.assertStops("来ない", sent_max=0)
        self.desk = FakeDesktop(self.k)
        self.desk.last_input = self.desk.now  # 人が今触ったまま、ずっと触っている
        self.desk.hooks = []
        orig = self.desk.sleep

        def sleep_and_touch(s):
            orig(s)
            self.desk.human()

        self.desk.sleep = sleep_and_touch
        self.assertStops("来ない", sent_max=0)

    def test_dialog_after_code_stops(self):
        def popup(d):
            if d.sent == [("char", "1"), ("char", "0"), ("char", "1"), ("key", "Enter")]:
                d.extra_windows.append(TopWindow(hwnd=200, class_name="#32770", title="確認"))
        self.desk.hooks.append(popup)
        self.assertStops("ダイアログ", sent_max=4)

    def test_stop_title_window_stops(self):
        def popup(d):
            if d.sent[-1] == ("key", "Enter"):
                d.extra_windows.append(TopWindow(hwnd=201, class_name="ThunderRT6FormDC", title="部品の選択"))
        self.desk.hooks.append(popup)
        self.assertStops("小窓", sent_max=4)

    def test_foreground_switch_mid_run_stops(self):
        def switch(d):
            if len(d.sent) == 5:
                d.window = WindowInfo(**{**d.window.__dict__, "hwnd": 999})
        self.desk.hooks.append(switch)
        self.assertStops("始めたとき", sent_max=5)

    def test_labor_branch_stops(self):
        # 担当の Enter の後に、点数（x=1070）へ進んだら止める
        labor = {"field": "点数", "class": "NumEdit", "x": 1070, "width": 75}

        def to_labor(d):
            if len(d.sent) == 7:
                d.fields[d.pos] = (1, labor)
        self.desk.hooks.append(to_labor)
        self.assertStops("明細1.数量 を待ったが来ない", sent_max=7)

    def test_position_tolerance(self):
        g = groups_for(LINE_A)
        r = self.desk._rect(1, self.k.path[0])
        self.desk.focus_override = FocusInfo(pid=7, class_name="NumEdit", rect=(r[0] + 3, r[1] - 3, r[2] + 3, r[3]), name="")
        # ±3 は通る（始められる）。その後の打鍵で Name が変わらないので読み返しで止まる
        self.assertStops("読み返し", groups=g)
        self.assertGreater(len(self.desk.sent), 0)
        self.desk = FakeDesktop(self.k)
        self.desk.focus_override = FocusInfo(pid=7, class_name="NumEdit", rect=(r[0] + 4, r[1], r[2] + 4, r[3]), name="")
        self.assertStops("来ない", groups=g, sent_max=0)

    def test_wrong_class_or_process_or_width(self):
        r = self.desk._rect(1, self.k.path[0])
        for f in (FocusInfo(7, "TextEdit", r, ""), FocusInfo(8, "NumEdit", r, ""),
                  FocusInfo(7, "NumEdit", (r[0], r[1], r[0] + 200, r[3]), ""), "none"):
            self.desk = FakeDesktop(self.k)
            self.desk.focus_override = f
            with self.subTest(f=f):
                self.assertStops("来ない", sent_max=0)

    def test_human_key_between_steps_stops(self):
        def touch(d):
            if len(d.sent) == 2:
                d.last_input = d.now + 120  # 送った後の待つ間（送ってから 100 ミリ秒より後）に人が触る
        self.desk.hooks.append(touch)
        self.assertStops("人が", sent_max=2)

    def test_human_key_while_waiting_focus_stops(self):
        orig = self.desk.sleep
        state = {"n": 0}

        def sleep(s):
            orig(s)
            state["n"] += 1
            if len(self.desk.sent) == 4 and state["n"] > 0:
                self.desk.human()

        self.desk.sleep = sleep
        self.assertStops("人が", sent_max=4)

    def test_human_key_right_after_send_seen_by_hook(self):
        # 送ってから 100 ミリ秒の内の人の入力は、時刻では自分の入力と分けられない。フックの injected の印で止める
        def touch(d):
            if len(d.sent) == 2:
                d.last_input = d.now + 1
                d.human_flag = True
        self.desk.hooks.append(touch)
        self.assertStops("人が", sent_max=2)

    def test_human_click_before_start_is_not_counted(self):
        self.desk.human_flag = True  # 人が欄をクリックした（始める前）
        run(self.desk, groups_for(LINE_A))
        self.assertEqual(self.desk.sent[-1], ("key", "Enter"))

    def test_late_popup_after_enter_stops_before_next_send(self):
        # 項目CD の Enter の 300 ミリ秒後に小窓が出る。次の欄で落ち着くのを待つ間に見つけ、何も送らない
        def popup(d):
            if d.sent[-1] == ("key", "Enter") and len(d.sent) == 4:
                d.delayed.append((d.now + 300, TopWindow(hwnd=202, class_name="ThunderRT6FormDC", title="部品の選択")))
        self.desk.hooks.append(popup)
        self.assertStops("小窓", sent_max=4)

    def test_mouse_move_stops(self):
        def move(d):
            if len(d.sent) == 3:
                d.cursor = (501, 500)
        self.desk.hooks.append(move)
        self.assertStops("マウス", sent_max=3)

    def test_modifier_held_stops(self):
        def hold(d):
            if len(d.sent) == 1:
                d.held = True
        self.desk.hooks.append(hold)
        self.assertStops("修飾キー", sent_max=1)

    def test_own_input_is_not_human_input(self):
        # 送った自分の入力（GetLastInputInfo が進む）では止まらない
        run(self.desk, groups_for(LINE_A))
        self.assertEqual(len(self.desk.sent), 3 + 4 + 1 + 1 + 4 + 1)

    def test_tick_wraparound(self):
        self.desk.now = 0xFFFFFFFF - 50
        self.desk.last_input = self.desk.now - 10_000
        run(self.desk, groups_for(LINE_A))
        self.assertEqual(self.desk.sent[-1], ("key", "Enter"))

    def test_readback_mismatch_stops_before_enter(self):
        def drop(d):
            if d.sent == [("char", "1"), ("char", "0")]:
                d.drop_chars = True
        self.desk.hooks.append(drop)
        e = self.assertStops("読み返しが合わない", sent_max=3)
        self.assertNotIn(("key", "Enter"), self.desk.sent)
        self.assertIn("***(2 文字)", str(e))

    def test_prefilled_field_stops(self):
        self.desk.names[0] = "9"
        self.assertStops("空でない", sent_max=0)

    def test_no_master_name_stops(self):
        self.desk.master = False
        self.assertStops("名前が入っていない", sent_max=4)

    def test_focus_jumps_mid_value_stops(self):
        # 打っている途中でフォーカスが次の欄へ移る（桁がいっぱいで自動で進む等）と、残りの文字を送らない
        def jump(d):
            if d.sent == [("char", "1")]:
                d.pos += 1
        self.desk.hooks.append(jump)
        self.assertStops("クラス|位置", sent_max=1)

    def test_last_row_lands_on_next_row(self):
        def stuck(d):
            if len(d.sent) == 14:  # 最後の Enter で次の行へ移らない
                d.pos -= 1
        self.desk.hooks.append(stuck)
        self.assertStops("明細2.項目CD を待ったが来ない", groups=groups_for(LINE_A))

    def test_sender_refuses_disallowed_key_and_char(self):
        s = send.Sender(self.desk, self.k, groups_for(LINE_A), lambda m: None)
        t = groups_for(LINE_A)[0].target
        for key in ("F8", "Escape", "Delete", "ctrl+S", "Down"):
            with self.subTest(key=key), self.assertRaises(Stop):
                s._send_key(t, key)
        for ch in ("a", ".", "-", "{"):
            with self.subTest(ch=ch), self.assertRaises(Stop):
                s._send_char(t, ch)
        self.assertEqual(self.desk.sent, [])


@unittest.skipUnless(sys.platform == "win32", "Windows の構造体だけを見る（何も送らない）")
class WinSendTest(unittest.TestCase):
    def test_only_allowed_keys_have_inputs(self):
        from inputter import winsend

        self.assertEqual(set(winsend.KEY_VK), send.SEND_KEYS)
        for bad in ("F8", "Escape", "Delete", "Alt", "Down", "Enter "):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                winsend.key_inputs(bad)
        down, up = winsend.key_inputs("Enter")
        self.assertEqual((down.type, down.u.ki.wVk, down.u.ki.dwFlags), (1, 0x0D, 0))
        self.assertEqual(up.u.ki.dwFlags, winsend.KEYEVENTF_KEYUP)
        if sys.maxsize > 2**32:
            self.assertEqual(winsend.ctypes.sizeof(winsend.INPUT), 40)

    def test_chars(self):
        from inputter import winsend

        self.assertEqual(winsend.char_inputs("7")[0].u.ki.wVk, 0x37)
        self.assertEqual(winsend.char_inputs(".")[0].u.ki.wVk, 0xBE)
        a = winsend.char_inputs("ア")[0].u.ki
        self.assertEqual((a.wVk, a.wScan, a.dwFlags), (0, ord("ア"), winsend.KEYEVENTF_UNICODE))
        for bad in ("\r", "\n", "\t", "\x1b", "ab", ""):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                winsend.char_inputs(bad)

    def test_send_checks_count(self):
        from unittest import mock

        from inputter import winsend

        with mock.patch.object(winsend, "_send_input", return_value=1) as m:
            with self.assertRaises(OSError):
                winsend._send(winsend.key_inputs("Tab"))
            self.assertEqual(len(m.call_args[0][0]), 2)


class MainSendTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path

        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.dir = Path(d.name)
        self.job = self._write("job.json", job(LINE_A | {"qty": 4}))
        self.items = self._write("items.json", ITEMS)

    def _write(self, name, data):
        p = self.dir / name
        p.write_text(json.dumps(data, ensure_ascii=False, default=str), encoding="utf-8")
        return str(p)

    def _run(self, argv):
        import io
        from contextlib import redirect_stderr, redirect_stdout

        from inputter.__main__ import main

        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_dry_run_default(self):
        sys.modules.pop("inputter.winsend", None)
        code, out, err = self._run(["send", self.job, "--items", self.items])
        self.assertEqual(code, 0, err)
        self.assertIn("ドライラン", out)
        self.assertIn("confirmed: False", out)
        self.assertNotIn("7777", out)
        self.assertNotIn("inputter.winsend", sys.modules)

    def test_send_refused_while_unconfirmed(self):
        sys.modules.pop("inputter.winsend", None)
        code, out, err = self._run(["send", self.job, "--items", self.items, "--send"])
        self.assertEqual(code, 2)
        self.assertIn("confirmed", err)
        self.assertNotIn("inputter.winsend", sys.modules)

    def test_send_flag_forms_refused(self):
        for argv in (
            ["send", self.job, "--items", self.items, "--se"],
            ["send", self.job, "--items", self.items, "--send=1"],
            ["plan", self.job, "--items", self.items, "--send"],
            ["--send", "send", self.job, "--items", self.items],
        ):
            with self.subTest(argv=argv):
                code, out, err = self._run(argv)
                self.assertEqual(code, 2)
                self.assertEqual(out, "")

    def test_plan_error_in_send_hides_values(self):
        bad = self._write("bad.json", job({"item": "架空の部品A", "qty": 1.25, "unit": "本", "unitPrice": 100}))
        code, out, err = self._run(["send", bad, "--items", self.items])
        self.assertEqual(code, 1)
        self.assertNotIn("1.25", err)
        self.assertNotIn("架空の部品A", err)

    def test_free_entry_refused_before_anything(self):
        bad = self._write("bad.json", job({"item": "架空の自由入力", "qty": 1, "unit": "本", "unitPrice": 100}))
        code, out, err = self._run(["send", bad, "--items", self.items, "--send"])
        self.assertEqual(code, 1)
        self.assertIn("何も送っていない", err)


if __name__ == "__main__":
    unittest.main()
