"""python -m inputter（inputter/__main__.py）の試験。送る機能は無く、--send は断る。"""

import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from inputter.__main__ import main

JOB = {
    "job_id": "test-job-1",
    "customer_code": 9001,
    "car_code": 9002,
    "lines": [{"item": "架空の作業A", "qty": 4, "unit": "本", "unitPrice": 1000}],
}
ITEMS = {"items": {"架空の作業A": 101}}


class MainTest(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.dir = Path(d.name)
        self.job = self._write("job.json", JOB)
        self.items = self._write("items.json", ITEMS)

    def _write(self, name, data):
        p = self.dir / name
        p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return str(p)

    def _run(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_plan_prints_dry_run(self):
        code, out, _ = self._run(["plan", self.job, "--items", self.items])
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual(data["mode"], "dry-run")
        self.assertIs(data["columns_confirmed"], False)
        self.assertIn({"field": "明細1.項目CD", "action": "type", "value": "101"}, data["steps"])

    def test_send_refused_anywhere(self):
        for argv in (
            ["plan", self.job, "--items", self.items, "--send"],
            ["--send", "plan", self.job, "--items", self.items],
            ["plan", self.job, "--send=1", "--items", self.items],
            ["plan", self.job, "--items", self.items, "--se"],
        ):
            with self.subTest(argv=argv):
                code, out, err = self._run(argv)
                self.assertNotEqual(code, 0)
                self.assertEqual(out, "")
                self.assertIn("Codex", err)

    def test_plan_error_exits_nonzero(self):
        bad = self._write("bad.json", {**JOB, "lines": [{"item": "架空の作業A", "qty": None, "unit": None, "unitPrice": 1}]})
        code, out, err = self._run(["plan", bad, "--items", self.items])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("null", err)

    def test_guard_error_exits_nonzero(self):
        cols = self._write("cols.json", {
            "advance_key": "F8",
            "columns": [
                {"field": "項目CD", "source": "code"},
                {"field": "作業内容", "source": "name"},
                {"field": "数量", "source": "qty"},
                {"field": "単価", "source": "unit_price"},
            ],
        })
        code, out, err = self._run(["plan", self.job, "--items", self.items, "--columns", cols])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("F8", err)

    def test_window_sending_only_in_winsend(self):
        # 窓にキーを送るもの・Windows を読むものは winsend.py だけに置く（判定の send.py は Windows に依存しない）
        pkg = Path(__file__).resolve().parents[1] / "inputter"
        for p in pkg.glob("*.py"):
            if p.name == "winsend.py":
                continue
            src = p.read_text(encoding="utf-8")
            for name in ("pywinauto", "SendInput", "ctypes", "win32api", "keybd_event", "pyautogui", "comtypes", "uiautomation"):
                with self.subTest(file=p.name, name=name):
                    self.assertNotIn(name, src)
        win = (pkg / "winsend.py").read_text(encoding="utf-8")
        # クリック・マウスの入力・F キー・Esc・Delete を作る道は持たない
        for name in ("MOUSEINPUT", "INPUT_MOUSE", "mouse_event", "SetCursorPos", "VK_F", "0x70", "0x1B", "0x2E", "PostMessage", "SendMessage", "Invoke"):
            with self.subTest(name=name):
                self.assertNotIn(name, win)


if __name__ == "__main__":
    unittest.main()
