"""記録の判定と保存の試験。Windows に依存しないので Mac でも回せる。
実行（office フォルダで）: python -m unittest discover -s tests
"""

import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from recorder.core import MASK, Click, Element, Snapshot, Store, Tracker, Window, cleanup

W1 = Window(handle=1, title="請求書入力", class_name="TForm", rect=(0, 0, 800, 600))
W2 = Window(handle=1, title="請求書確認", class_name="TForm", rect=(0, 0, 800, 600))
NAME = Element(name="品名", automation_id="edtItem", control_type="EditControl", value="")
PRICE = Element(name="単価", automation_id="edtPrice", control_type="EditControl", value="")
PASSWORD = Element(name="パスワード", automation_id="edtPass", control_type="EditControl", value="", is_password=True)
OK = Element(name="登録", automation_id="btnOk", control_type="ButtonControl")


def kinds(events):
    return [e.kind for e in events]


class TrackerTest(unittest.TestCase):
    def test_対象のソフトが起動していなければ何も記録しない(self):
        t = Tracker()
        self.assertEqual(t.observe(Snapshot(target_pid=None)), [])

    def test_起動と終了で区切る(self):
        t = Tracker()
        self.assertEqual(kinds(t.observe(Snapshot(target_pid=10, target_exe="RacroS.exe"))), ["session_start"])
        self.assertEqual(kinds(t.observe(Snapshot(target_pid=None))), ["session_end"])

    def test_窓が変わったら記録してスクリーンショットを撮る(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10))
        ev = t.observe(Snapshot(target_pid=10, window=W1))
        self.assertEqual(kinds(ev), ["window"])
        self.assertEqual(ev[0].screenshot, "window")
        self.assertEqual(t.observe(Snapshot(target_pid=10, window=W1)), [])  # 変わらなければ記録しない
        self.assertEqual(kinds(t.observe(Snapshot(target_pid=10, window=W2))), ["window"])  # 題名が変わった

    def test_欄から離れたときに値の変化を残す(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10, window=W1, focus=NAME))
        t.observe(Snapshot(target_pid=10, window=W1, focus=Element(**{**NAME.__dict__, "value": "タイヤ組替"})))
        ev = t.observe(Snapshot(target_pid=10, window=W1, focus=PRICE))
        self.assertEqual(kinds(ev), ["value_changed", "focus"])
        self.assertEqual(ev[0].data["before"], "")
        self.assertEqual(ev[0].data["after"], "タイヤ組替")
        self.assertEqual(ev[0].data["element"]["automation_id"], "edtItem")

    def test_値が変わっていなければ残さない(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10, focus=NAME))
        self.assertEqual(kinds(t.observe(Snapshot(target_pid=10, focus=PRICE))), ["focus"])

    def test_パスワード欄の値は伏せる(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10, focus=PASSWORD))
        t.observe(Snapshot(target_pid=10, focus=Element(**{**PASSWORD.__dict__, "value": "secret"})))
        ev = t.observe(Snapshot(target_pid=10, focus=NAME))
        self.assertEqual(ev[0].data["after"], MASK)
        self.assertEqual(ev[0].data["element"]["value"], MASK)
        self.assertNotIn("secret", json.dumps([e.data for e in ev], ensure_ascii=False))

    def test_ボタンのクリックはスクリーンショットを撮り_欄のクリックは撮らない(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10, window=W1))
        ev = t.observe(Snapshot(target_pid=10, window=W1, clicks=[Click(1, 2, "left", OK, 0), Click(3, 4, "left", NAME, 0)]))
        self.assertEqual([(e.kind, e.screenshot) for e in ev], [("click", "click"), ("click", None)])

    def test_終了時に入力途中の値も残す(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10, focus=PRICE))
        t.observe(Snapshot(target_pid=10, focus=Element(**{**PRICE.__dict__, "value": "2200"})))
        self.assertEqual(kinds(t.flush()), ["value_changed", "session_end"])

    def test_長い値は切り詰める(self):
        e = Element(name="備考", value="あ" * 1000)
        self.assertEqual(len(e.to_dict()["value"]), 500)


class StoreTest(unittest.TestCase):
    def test_起動ごとにフォルダを分けて_JSONL_に書く(self):
        with tempfile.TemporaryDirectory() as d:
            now = [1_700_000_000.0]
            s = Store(Path(d), clock=lambda: now[0])
            t = Tracker()
            for e in t.observe(Snapshot(target_pid=10, window=W1)):
                s.write(e)
            for e in t.observe(Snapshot(target_pid=None)):
                s.write(e)
            files = list(Path(d).glob("*/session-*/events.jsonl"))
            self.assertEqual(len(files), 1)
            lines = [json.loads(x) for x in files[0].read_text(encoding="utf-8").splitlines()]
            self.assertEqual([x["kind"] for x in lines], ["session_start", "window", "session_end"])

    def test_スクリーンショットは間隔を空ける(self):
        with tempfile.TemporaryDirectory() as d:
            now = [100.0]
            s = Store(Path(d), min_shot_interval=2.0, clock=lambda: now[0])
            s.open_session()
            self.assertIsNotNone(s.screenshot_path("window"))
            now[0] += 1
            self.assertIsNone(s.screenshot_path("click"))
            now[0] += 2
            p = s.screenshot_path("click")
            self.assertTrue(p is not None and p.name == "0002-click.jpg")


class CleanupTest(unittest.TestCase):
    def test_古い日付のフォルダだけ消す(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name in ["2026-10-20", "2026-11-01", "2026-11-04", "dumps"]:
                (root / name).mkdir()
            removed = cleanup(root, keep_days=7, today=date(2026, 11, 4))
            self.assertEqual([p.name for p in removed], ["2026-10-20"])
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["2026-11-01", "2026-11-04", "dumps"])


if __name__ == "__main__":
    unittest.main()
