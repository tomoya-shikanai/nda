"""inputter/watch.py の試験。偽の伝票の画面で、人が Enter を押すのをまねて、読むだけの照らし合わせを確かめる。"""

import unittest

from inputter import send, watch
from inputter.__main__ import _ReadOnly
from inputter.plan import load_json
from test_inputter_send import FakeDesktop, kp

KP_DATA = load_json(send.KEYPATH_PATH)


class ShapeTest(unittest.TestCase):
    def test_shapes_hide_values(self):
        self.assertEqual(watch.shape("NumEdit", ""), "空")
        self.assertEqual(watch.shape("NumEdit", "7777"), "数字")
        self.assertEqual(watch.shape("NumEdit", "12,345"), "数字・カンマつき")
        self.assertEqual(watch.shape("NumEdit", "1.5"), "小数点つき（小数 1 桁）")
        self.assertEqual(watch.shape("NumEdit", "1,234.00"), "小数点つき（小数 2 桁）・カンマつき")
        self.assertEqual(watch.shape("TextEdit", "山田"), "文字あり")
        for s in (watch.shape("NumEdit", "7777"), watch.shape("TextEdit", "山田")):
            self.assertNotIn("7777", s)
            self.assertNotIn("山田", s)


class WatchTest(unittest.TestCase):
    def setUp(self):
        self.k = kp()
        self.desk = FakeDesktop(self.k)
        self.events = []
        self.w = watch.Watcher(_ReadOnly(self.desk), self.k, KP_DATA, self.events.append)

    def human_enter(self, n=1):
        for _ in range(n):
            self.desk.send_key("Enter")  # 人が押したことのまね（watch は送らない）
            self.w.step()

    def test_follows_row_path_in_order(self):
        self.w.step()
        self.human_enter(6)
        fields = [e["field"] for e in self.events if e["kind"] == "focus"]
        self.assertEqual(fields, ["明細1.項目CD", "明細1.作業内容", "明細1.作業区分", "明細1.担当", "明細1.数量", "明細1.単価", "明細2.項目CD"])
        self.assertEqual(self.w.counts["順どおり"], 6)
        self.assertEqual(self.w.counts["順と違う"], 0)

    def test_out_of_order_is_flagged(self):
        self.w.step()
        self.desk.pos += 2  # 作業内容を飛ばして作業区分へ（人がクリックしたなど）
        self.w.step()
        self.assertEqual(self.events[-1]["verdict"], "順と違う")

    def test_values_are_never_output(self):
        self.w.step()
        for ch in "7777":
            self.desk.send_char(ch)
            self.w.step()
        joined = repr(self.events) + "\n".join(watch.line(e) for e in self.events)
        self.assertNotIn("7777", joined)
        self.assertTrue(any(e["kind"] == "value" and e["shape"] == "数字" for e in self.events))

    def test_other_window_and_dialog(self):
        self.w.step()
        self.desk.extra_windows.append(send.TopWindow(hwnd=5, class_name="#32770", title="山田様 確認"))
        self.w.step()
        self.assertEqual(self.events[-1], {"kind": "dialog", "count": 1})
        self.assertNotIn("山田", watch.line(self.events[-1]))

    def test_read_only_wrapper_has_no_send(self):
        ro = _ReadOnly(self.desk)
        for name in ("send_key", "send_char", "sleep"):
            self.assertFalse(hasattr(ro, name))

    def test_watch_never_sends(self):
        self.w.step()
        sent_before = list(self.desk.sent)
        for _ in range(20):
            self.w.step()
        self.assertEqual(self.desk.sent, sent_before)


if __name__ == "__main__":
    unittest.main()
