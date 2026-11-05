"""送る前の許可リスト（inputter/guard.py）の試験。"""

import unittest

from inputter.guard import GuardError, check_plan

OK = [
    {"field": "明細1.項目CD", "action": "type", "value": "101"},
    {"field": "明細1.項目CD", "action": "key", "value": "Enter"},
    {"field": "明細1.作業内容", "action": "type", "value": "架空の作業（アルミ）・A"},
    {"field": "明細1.作業内容", "action": "key", "value": "Tab"},
    {"field": "明細1.行の終わり", "action": "key", "value": "Down"},
    {"field": "明細1.行の終わり", "action": "key", "value": "Up"},
    {"field": "明細1.行の終わり", "action": "key", "value": "Left"},
    {"field": "明細1.行の終わり", "action": "key", "value": "Right"},
]


class GuardTest(unittest.TestCase):
    def _rejects(self, step):
        with self.assertRaises(GuardError):
            check_plan(OK + [step])

    def test_accepts_normal_plan(self):
        self.assertEqual(check_plan(OK), OK)

    def test_rejects_empty(self):
        for plan in ([], None, {}):
            with self.subTest(plan=plan), self.assertRaises(GuardError):
                check_plan(plan)

    def test_rejects_function_keys(self):
        for n in range(1, 13):
            with self.subTest(n=n):
                self._rejects({"field": "x", "action": "key", "value": f"F{n}"})

    def test_rejects_modifier_combos(self):
        for v in ("Alt+F", "ctrl+S", "Ctrl+P", "Win", "Win+R", "%f", "^s", "Alt", "Control", "Shift+Tab"):
            with self.subTest(v=v):
                self._rejects({"field": "x", "action": "key", "value": v})

    def test_rejects_escape_delete_and_others(self):
        for v in ("Escape", "Esc", "Delete", "Del", "Backspace", "Home", "enter", "ENTER", ""):
            with self.subTest(v=v):
                self._rejects({"field": "x", "action": "key", "value": v})

    def test_rejects_mouse_and_toolbar(self):
        for step in (
            {"field": "x", "action": "click", "value": "100,200"},
            {"field": "ツールバー", "action": "toolbar", "value": "新規"},
            {"field": "x", "action": "key", "value": "Enter", "x": 10, "y": 20},
            {"field": "x", "action": "type"},
            "Enter",
        ):
            with self.subTest(step=step):
                self._rejects(step)

    def test_rejects_forbidden_words(self):
        for w in ("保存", "印保存", "確定", "発行", "印刷", "削除"):
            with self.subTest(w=w):
                self._rejects({"field": f"ボタン{w}", "action": "key", "value": "Enter"})
                self._rejects({"field": "明細1.作業内容", "action": "type", "value": f"架空{w}"})

    def test_rejects_control_chars_in_text(self):
        for v in ("a\nb", "a\tb", "a\rb", "\x1b", "a\x00", "", "a‎b"):
            with self.subTest(v=repr(v)):
                self._rejects({"field": "x", "action": "type", "value": v})

    def test_rejects_send_meta_chars_in_text(self):
        for v in ("{F8}", "^s", "%f", "+a", "~", "(a)"):
            with self.subTest(v=v):
                self._rejects({"field": "x", "action": "type", "value": v})

    def test_reports_every_violation(self):
        with self.assertRaises(GuardError) as cm:
            check_plan(
                [
                    {"field": "x", "action": "key", "value": "F8"},
                    {"field": "保存", "action": "key", "value": "Enter"},
                ]
            )
        self.assertEqual(len(cm.exception.violations), 2)


if __name__ == "__main__":
    unittest.main()
