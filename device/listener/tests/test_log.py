"""聞き役の出来事の記録の試験（docs/logging.md）。自分で作った一時フォルダだけを見る。
実行（device/listener フォルダで）: python3 -m unittest discover -s tests
"""

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from listener_core import is_wake, log_event, send_result, wake_conf  # noqa: E402

NOW = datetime(2026, 11, 8, 9, 30, tzinfo=timezone.utc)


def vosk(*pairs):
    return {"result": [{"word": w, "conf": c} for w, c in pairs], "text": " ".join(w for w, _ in pairs)}


class WakeConfTest(unittest.TestCase):
    def test_続けて出た所の最小のconf(self):
        self.assertEqual(wake_conf(vosk(("んだ", 0.98), ("クロード", 0.91))), 0.91)

    def test_複数あれば最大(self):
        self.assertEqual(wake_conf(vosk(("んだ", 0.6), ("クロード", 0.7), ("んだ", 0.95), ("クロード", 0.93))), 0.93)

    def test_出ていない_形が違うならNone(self):
        self.assertIsNone(wake_conf(vosk(("[unk]", 1.0))))
        self.assertIsNone(wake_conf({"text": ""}))
        self.assertIsNone(wake_conf({"result": [{"word": "んだ"}]}))

    def test_is_wakeはwake_confと下限で決まる(self):
        r = vosk(("んだ", 0.95), ("クロード", 0.85))
        self.assertFalse(is_wake(r, min_conf=0.9))
        self.assertTrue(is_wake(r, min_conf=0.8))


class LogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="nda-listener-log-")
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def lines(self):
        p = os.path.join(self.dir, "listener-2026-11-08.jsonl")
        with open(p, encoding="utf-8") as f:
            return [json.loads(x) for x in f if x.strip()]

    def test_決めた形の出来事を1行ずつ足す(self):
        log_event("wake", {"conf": 0.93, "accepted": True, "minConf": 0.9}, self.dir, NOW)
        log_event("record", {"sec": 3.2, "spoke": True}, self.dir, NOW)
        log_event("send", {"ms": 812, "status": 409, "result": "conflict"}, self.dir, NOW)
        got = self.lines()
        self.assertEqual([x["kind"] for x in got], ["wake", "record", "send"])
        self.assertEqual(got[0]["conf"], 0.93)
        self.assertEqual(got[2]["status"], 409)

    def test_自由な文字列_余計な欄_欠けた欄は捨ててlog_invalid(self):
        log_event("wake", {"conf": 0.93, "accepted": True, "minConf": 0.9, "text": "んだ クロード 仮田さんの1111"}, self.dir, NOW)
        log_event("send", {"ms": 1, "status": 200, "result": "仮田様"}, self.dir, NOW)
        log_event("record", {"sec": "3.2", "spoke": True}, self.dir, NOW)
        log_event("record", {"sec": True, "spoke": True}, self.dir, NOW)
        log_event("record", {"sec": float("nan"), "spoke": True}, self.dir, NOW)
        log_event("said", {"x": 1}, self.dir, NOW)
        got = self.lines()
        self.assertEqual([x["kind"] for x in got], ["log.invalid"] * 6)
        self.assertEqual(got[-1]["of"], "unknown")
        raw = Path(self.dir, "listener-2026-11-08.jsonl").read_text(encoding="utf-8")
        for bad in ("仮田", "1111", "クロード", "said"):
            self.assertNotIn(bad, raw)

    def test_置き場が無ければ記録しない_書けなくても投げない(self):
        old = os.environ.pop("NDA_LOG_DIR", None)
        try:
            log_event("record", {"sec": 1.0, "spoke": False}, None, NOW)
            self.assertEqual(os.listdir(self.dir), [])
            blocker = os.path.join(self.dir, "file")
            Path(blocker).write_text("")
            log_event("record", {"sec": 1.0, "spoke": False}, os.path.join(blocker, "sub"), NOW)
        finally:
            if old is not None:
                os.environ["NDA_LOG_DIR"] = old

    def test_送信の結果の種類(self):
        self.assertEqual([send_result(s) for s in (200, 201, 409, 422, 502, None)], ["ok", "ok", "conflict", "rejected", "rejected", "unreachable"])


if __name__ == "__main__":
    unittest.main()
