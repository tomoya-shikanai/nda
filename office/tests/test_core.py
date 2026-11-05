"""記録の判定と保存の試験。Windows に依存しないので Mac でも回せる。
実行（office フォルダで）: python -m unittest discover -s tests
"""

import json
import os
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

from recorder.core import MASK, Click, Element, Key, Snapshot, Store, Tracker, Window, cleanup, mask_title, toolbar_button

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

    def test_起動の記録に対象のプロセスを残す(self):
        t = Tracker()
        (e,) = t.observe(Snapshot(target_pid=10, target_exe="RacroS.exe", target_path=r"C:\RacroS\RacroS.exe"))
        self.assertEqual(e.data, {"pid": 10, "exe": "RacroS.exe", "path": r"C:\RacroS\RacroS.exe"})

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

    def test_一度でも保護された欄は離れるまで伏せる(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10, focus=NAME))
        t.observe(Snapshot(target_pid=10, focus=PRICE))  # 入った時は保護されていない
        t.observe(Snapshot(target_pid=10, focus=Element(**{**PRICE.__dict__, "value": "SECRET", "is_password": True})))
        t.observe(Snapshot(target_pid=10, focus=Element(**{**PRICE.__dict__, "value": "2200"})))
        ev = t.observe(Snapshot(target_pid=10, focus=NAME))
        self.assertEqual(kinds(ev), ["value_changed", "focus"])
        self.assertEqual((ev[0].data["before"], ev[0].data["after"], ev[0].data["element"]["value"]), (MASK, MASK, MASK))

    def test_保護中に入った欄の値が後で_before_に出ない(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10, focus=Element(**{**PRICE.__dict__, "value": "SECRET", "is_password": True})))
        t.observe(Snapshot(target_pid=10, focus=Element(**{**PRICE.__dict__, "value": "2200"})))
        ev = t.observe(Snapshot(target_pid=10, focus=NAME))
        self.assertNotIn("SECRET", json.dumps([e.data for e in ev], ensure_ascii=False))
        self.assertEqual(ev[0].data["before"], MASK)

    def test_保護された欄を離れたら次の欄は伏せない(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10, focus=Element(**{**PRICE.__dict__, "value": "x", "is_password": True})))
        t.observe(Snapshot(target_pid=10, focus=NAME))
        t.observe(Snapshot(target_pid=10, focus=Element(**{**NAME.__dict__, "value": "タイヤ組替"})))
        ev = t.observe(Snapshot(target_pid=10, focus=PRICE))
        self.assertEqual(ev[0].data["after"], "タイヤ組替")

    def test_長い値は切り詰める(self):
        e = Element(name="備考", value="あ" * 1000)
        self.assertEqual(len(e.to_dict()["value"]), 500)


class RecorderFixTest(unittest.TestCase):
    """#48: 伏せる値・キー・ツールバー・exe・段階ごとの失敗。"""

    def _masked(self, v):
        return Element(control_type="PaneControl", class_name="TextEdit", value=v, value_source="name", masked=True)

    def test_伏せる欄の値の変化は文字数だけ残す(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10, window=W1, focus=self._masked("")))
        t.observe(Snapshot(target_pid=10, window=W1, focus=self._masked("山田太郎")))
        ev = t.observe(Snapshot(target_pid=10, window=W1, focus=PRICE))
        self.assertEqual(kinds(ev), ["value_changed", "focus"])
        d = ev[0].data
        self.assertEqual((d["before"], d["after"], d["before_len"], d["after_len"]), (MASK, MASK, 0, 4))
        self.assertNotIn("山田", json.dumps([e.data for e in ev], ensure_ascii=False))

    def test_入力の途中で欄の記録が増えない(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10, window=W1, focus=self._masked("1")))
        self.assertEqual(t.observe(Snapshot(target_pid=10, window=W1, focus=self._masked("12"))), [])

    def test_欄の移動に実行ファイル名を付ける(self):
        t = Tracker()
        w = Window(handle=1, title="x", class_name="F", rect=(0, 0, 1, 1), exe="M_NOU.exe")
        ev = t.observe(Snapshot(target_pid=10, window=w, focus=PRICE))
        self.assertEqual([e.data.get("exe") for e in ev if e.kind == "focus"], ["M_NOU.exe"])

    def test_ツールバーの押した位置をボタン名にする(self):
        tb = Element(control_type="PaneControl", class_name="msvb_lib_toolbar", rect=(196, 90, 1795, 144))
        self.assertEqual(toolbar_button("M_NOU.exe", tb, 196 + 405), "印保存")
        self.assertEqual(toolbar_button("m_nou.exe", tb, 196 + 355), "保存")
        self.assertEqual(toolbar_button("M_CAR.exe", tb, 196 + 245), "検索")
        self.assertEqual(toolbar_button("M_NOU.exe", tb, 196 + 300), "修正")  # 作った伝票を開いたときだけある
        self.assertEqual(toolbar_button("M_NOU.exe", tb, 196 + 245), "転用|新規")  # 並びで割れる
        self.assertEqual(toolbar_button("M_NOU.exe", tb, 196 + 1083), "シール")
        self.assertEqual(toolbar_button("M_NOU.exe", tb, 196 + 795), "?")  # ボタンの間
        self.assertEqual(toolbar_button("D_SYARE.exe", tb, 200), "?")  # 表の無い画面
        self.assertIsNone(toolbar_button("M_NOU.exe", PRICE, 10))  # ツールバーでない

    def test_ツールバーのクリックは名前を付けて撮る(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10))
        tb = Element(control_type="PaneControl", class_name="msvb_lib_toolbar", rect=(196, 90, 1795, 144))
        (e,) = t.observe(Snapshot(target_pid=10, clicks=[Click(x=196 + 465, y=100, button="left", element=tb, at=0, exe="M_NOU.exe")]))
        self.assertEqual((e.data["toolbar_button"], e.data["exe"], e.screenshot), ("印刷", "M_NOU.exe", "click"))
        self.assertEqual(e.data["toolbar_dx"], 465)

    def test_初めて入った欄では撮る(self):
        t = Tracker()
        w = Window(handle=1, title="x", class_name="F", rect=(100, 0, 1636, 1075), exe="M_NOU.exe")
        a = Element(control_type="EditControl", class_name="NumEdit", rect=(153, 566, 225, 590), masked=True, value="1")
        b = Element(name="b", control_type="EditControl", class_name="TextEdit", rect=(237, 566, 748, 590), masked=True, value="")
        (e1,) = [e for e in t.observe(Snapshot(target_pid=10, window=w, focus=a)) if e.kind == "focus"]
        self.assertEqual((e1.screenshot, e1.field_key), ("field", ("m_nou.exe", "NumEdit", 53, 566, 72, 24)))
        (e2,) = [e for e in t.observe(Snapshot(target_pid=10, window=w, focus=b)) if e.kind == "focus"]
        self.assertEqual(e2.screenshot, "field")  # 撮れなかった a は次に入ったとき撮り直す
        t.field_shot_done(e1.field_key)
        (e3,) = [e for e in t.observe(Snapshot(target_pid=10, window=w, focus=a)) if e.kind == "focus"]
        self.assertIsNone(e3.screenshot)

    def test_窓の題名の客の名前を伏せる(self):
        t = Tracker()
        w = Window(handle=1, title="[ 山田　太郎 ] - [ 納品請求書 ] - RacroSⅢ", class_name="F", rect=(0, 0, 1, 1), exe="M_NOU.exe")
        (e,) = [e for e in t.observe(Snapshot(target_pid=10, window=w)) if e.kind == "window"]
        self.assertEqual(e.data["title"], "*** - [ 納品請求書 ] - RacroSⅢ")
        self.assertNotIn("山田", json.dumps(e.data, ensure_ascii=False))
        self.assertEqual(mask_title("[ 車検証 ] - RacroSⅢ"), "[ 車検証 ] - RacroSⅢ")
        self.assertEqual(mask_title("確認"), "確認")
        form = Element(name="[ 山田　太郎 ] - [ 車検証 ] - RacroSⅢ", control_type="WindowControl", class_name="ThunderRT6FormDC")
        bar = Element(name="[ 山田　太郎 ] - [ 車検証 ] - RacroSⅢ", control_type="TitleBarControl")
        self.assertEqual(form.to_dict()["name"], "*** - [ 車検証 ] - RacroSⅢ")
        self.assertEqual(bar.to_dict()["name"], "*** - [ 車検証 ] - RacroSⅢ")

    def test_キーは種類と文字の数だけ残す(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10))
        (e,) = t.observe(Snapshot(target_pid=10, keys=[Key(key="tab", chars_before=3, at=0, exe="M_NOU.exe")]))
        self.assertEqual((e.kind, e.data), ("key", {"key": "tab", "chars_before": 3, "exe": "M_NOU.exe"}))

    def test_読み取りの失敗は段階つきで残す(self):
        t = Tracker()
        t.observe(Snapshot(target_pid=10))
        (e,) = t.observe(Snapshot(target_pid=10, errors=[{"stage": "focus", "error": "COMError: x"}]))
        self.assertEqual((e.kind, e.data["stage"]), ("error", "focus"))

    def test_ダイアログのボタンを窓の記録に残す(self):
        w = Window(handle=2, title="確認", class_name="#32770", rect=(0, 0, 1, 1), buttons=("はい(Y)", "いいえ(N)"))
        self.assertEqual(w.to_dict()["buttons"], ["はい(Y)", "いいえ(N)"])
        self.assertNotIn("buttons", W1.to_dict())


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


    def test_保存先が消えていたら作り直して書く(self):
        import shutil

        with tempfile.TemporaryDirectory() as d:
            now = [datetime(2026, 11, 4, 9, 0).timestamp()]
            s = Store(Path(d), clock=lambda: now[0])
            t = Tracker()
            for e in t.observe(Snapshot(target_pid=10, window=W1)):
                s.write(e)
            shutil.rmtree(s.dir)
            s.write(t.observe(Snapshot(target_pid=10, window=W2))[0])
            self.assertEqual(json.loads((s.dir / "events.jsonl").read_text(encoding="utf-8"))["kind"], "window")
            p = s.screenshot_path("window")
            self.assertTrue(p.parent.is_dir())

    def test_日付が変わったら新しい日付のフォルダに書く(self):
        with tempfile.TemporaryDirectory() as d:
            now = [datetime(2026, 11, 4, 23, 59).timestamp()]
            s = Store(Path(d), clock=lambda: now[0])
            t = Tracker()
            for e in t.observe(Snapshot(target_pid=10, window=W1)):
                s.write(e)
            first = s.dir
            now[0] = datetime(2026, 11, 5, 0, 1).timestamp()
            s.write(t.observe(Snapshot(target_pid=10, window=W2))[0])
            self.assertEqual(first.parent.name, "2026-11-04")
            self.assertEqual(s.dir.parent.name, "2026-11-05")
            lines = [json.loads(x) for x in (s.dir / "events.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual([x["kind"] for x in lines], ["session_continue", "window"])
            self.assertTrue(s.screenshot_path("window").is_relative_to(s.dir))


class CleanupTest(unittest.TestCase):
    def test_古い日付のフォルダだけ消す(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name in ["2026-10-20", "2026-11-01", "2026-11-04", "dumps", "other"]:
                (root / name).mkdir()
            removed = cleanup(root, keep_days=7, today=date(2026, 11, 4))
            self.assertEqual([p.name for p in removed], ["2026-10-20"])
            # dumps のフォルダ自体と、日付の形でないフォルダは残す（dumps の中身は下の試験）
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["2026-11-01", "2026-11-04", "dumps", "other"])

    def test_dumps_の古いファイルを消す(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "dumps").mkdir()
            old, new = root / "dumps" / "dump-20261020-090000.txt", root / "dumps" / "dump-20261101-090000.jpg"
            for f, day in ((old, datetime(2026, 10, 20, 9)), (new, datetime(2026, 11, 1, 9))):
                f.write_text("x")
                os.utime(f, (day.timestamp(), day.timestamp()))
            removed = cleanup(root, keep_days=7, today=date(2026, 11, 4))
            self.assertEqual(removed, [old])
            self.assertEqual([p.name for p in (root / "dumps").iterdir()], [new.name])

    def test_書いている最中のセッションのフォルダは消さない(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            now = [datetime(2026, 10, 20, 9).timestamp()]
            s = Store(root, clock=lambda: now[0])
            for e in Tracker().observe(Snapshot(target_pid=10, window=W1)):
                s.write(e)
            (root / "2026-10-21").mkdir()
            removed = cleanup(root, keep_days=7, today=date(2026, 11, 4), active=s.dir)
            self.assertEqual([p.name for p in removed], ["2026-10-21"])
            self.assertTrue((s.dir / "events.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
