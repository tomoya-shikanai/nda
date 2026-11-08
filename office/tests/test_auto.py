"""声の指示（estimate.instruction）と、全部自動の道（box.auto）の試験。DB・Claude・画面は偽物だけ。"""

import copy
import json
import tempfile
import unittest
import uuid
from pathlib import Path

from box import auto
from box.inbox import Abort, Hooks, Inbox
from box.lookup import CarInfo
from box.message import Reject, check_instruction, load_config
from estimator.catalog import build
from inputter.send import Stop
from test_estimator import RAW, TABLES, WORK

CFG = load_config({"allowed_customers": ["9001"], "item_codes": {"架空": 1}, "db_reader_file": "x"})
WHERE = {"recordingId": "rec-1", "startSec": 1.0, "endSec": 2.0, "quote": "＊＊さん"}


def instruction(**over):
    msg = {"v": 1, "id": str(uuid.uuid4()), "sessionId": "s-1", "sentAt": "2026-11-08T01:02:03.000Z",
           "kind": "estimate.instruction", "attempt": 1, "approvedAt": "2026-11-08T01:02:00Z", "approval": WHERE,
           "vehicle": {"plateNo": "7319", "carWords": ["サンバー"]}, "slipKind": "invoice", "work": WORK}
    msg.update(over)
    return msg


class CheckInstructionTest(unittest.TestCase):
    def test_good(self):
        job = check_instruction(instruction(), CFG, lambda h: (9001, 9002))
        self.assertEqual((job["customer_code"], job["car_code"], job["slip_kind"], job["instruction"]), (9001, 9002, "invoice", True))

    def test_rejects(self):
        cases = {
            "invalid": [instruction(slipKind="other"), instruction(work=""), instruction(work="x" * 2001),
                        instruction(work="改\n行"), instruction(extra=1), instruction(vehicle={"plateNo": "abc"}),
                        instruction(attempt=0)],
            "customerNotFound": [instruction()],
            "customerNotAllowed": [instruction()],
        }
        resolvers = {"invalid": lambda h: (9001, 9002), "customerNotFound": lambda h: None,
                     "customerNotAllowed": lambda h: (9003, 9002)}
        for reason, msgs in cases.items():
            for m in msgs:
                with self.subTest(reason=reason), self.assertRaises(Reject) as cm:
                    check_instruction(m, CFG, resolvers[reason])
                self.assertEqual(cm.exception.reason, reason)
        with self.assertRaises(Reject) as cm:
            check_instruction(instruction(), CFG, None)  # 解決の道が無ければ番号を推測しない
        self.assertEqual(cm.exception.reason, "customerNotFound")


class CliFlagsTest(unittest.TestCase):
    def test_until_list_needs_auto_and_send(self):
        from box.__main__ import main
        import io
        from contextlib import redirect_stderr
        for argv in (["run", "--until-list"], ["run", "--send", "--until-list"], ["run", "--auto"]):
            with self.subTest(argv=argv), redirect_stderr(io.StringIO()):
                self.assertEqual(main(argv + ["--root", "Z:/nowhere"]), 2)


class InboxPicksInstructionTest(unittest.TestCase):
    def test_only_auto_inbox_picks_instruction(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "in").mkdir()
            msg = instruction()
            (root / "in" / f"{msg['id']}.json").write_text(json.dumps(msg, ensure_ascii=False), encoding="utf-8")
            seen = []
            hooks = Hooks(prepare=lambda job: seen.append(job) or job, confirm=lambda job: True, enter=lambda p: 5,
                          post=lambda r: "noPi", log=lambda m: None)
            self.assertIsNone(Inbox(root, CFG, hooks).handle(next((root / "in").iterdir())))  # --auto でなければ拾わない
            rec = Inbox(root, CFG, hooks, resolve_vehicle=lambda h: (9001, 9002)).handle(next((root / "in").iterdir()))
            self.assertEqual(rec["result"]["outcome"], "entered")
            self.assertTrue(seen[0]["instruction"])


class AutoTest(unittest.TestCase):
    def job(self):
        return {"job_id": "t", "customer_code": 9001, "car_code": 9002, "slip_kind": "invoice", "work": WORK,
                "instruction": True}

    def prepared(self):
        info = CarInfo(plate="架空 500 あ 7319", no=7319, name="架空", title_name="架空　太郎", bango="500", kana="あ",
                       list_rows=2)
        return auto.prepare(self.job(), CFG, ask=lambda w, c: copy.deepcopy(RAW), look=lambda r, k, c: info,
                            load_catalog=lambda: build(TABLES), need_confirmed=False)

    def test_prepare_refuses_unconfirmed_settings(self):
        info = CarInfo(plate="架空 500 あ 7319", no=7319, name="架空", title_name="架空　太郎", bango="500", kana="あ",
                       list_rows=2)
        with self.assertRaisesRegex(RuntimeError, "確認済みでない"):  # 試験の設定は confirmed: false
            auto.prepare(self.job(), CFG, ask=lambda w, c: copy.deepcopy(RAW), look=lambda r, k, c: info,
                         load_catalog=lambda: build(TABLES))

    def test_prepare_makes_five_lines_and_target(self):
        p = self.prepared()
        self.assertEqual(p.lines, 5)
        self.assertEqual((p.target.kind, p.target.plate_kana, p.target.list_rows), ("invoice", "あ", 2))
        self.assertEqual(p.columns["labor_codes"], [278, 279])
        self.assertEqual(len(p.groups), 30)

    def setUp(self):
        self._oc = auto.opener_confirmed
        auto.opener_confirmed = lambda: True

    def tearDown(self):
        auto.opener_confirmed = self._oc

    def test_enter_refuses_when_openpath_unconfirmed(self):
        p = self.prepared()
        auto.opener_confirmed = lambda: False

        class Desk:
            def close(self):
                pass
        with self.assertRaises(Abort):
            auto.enter(p, lambda m: None, desk_factory=lambda: self.fail("窓を開かない"),
                       open_run=lambda *a, **k: self.fail("開かない"), send_run=lambda *a: self.fail("送らない"))

    def test_enter_opens_then_sends(self):
        p = self.prepared()
        calls = []

        class Desk:
            def close(self):
                calls.append("close")

        auto.enter(p, calls.append, desk_factory=Desk,
                   open_run=lambda d, t, log, stop_at_list: calls.append(("open", t.vehicle_no, stop_at_list)) or object(),
                   send_run=lambda d, kp, g, log, name: calls.append(("send", len(g), name)))
        self.assertEqual(calls, [("open", 7319, False), ("send", 30, "架空　太郎"), "close"])

    def test_until_list_and_stop_become_abort(self):
        p = self.prepared()

        class Desk:
            def close(self):
                pass

        with self.assertRaises(Abort):
            auto.enter(p, lambda m: None, stop_at_list=True, desk_factory=Desk,
                       open_run=lambda d, t, log, stop_at_list: None, send_run=lambda *a: self.fail("送らない"))

        def stop(*a, **k):
            raise Stop("止まった")
        with self.assertRaises(Abort):
            auto.enter(p, lambda m: None, desk_factory=Desk, open_run=stop, send_run=lambda *a: self.fail("送らない"))


if __name__ == "__main__":
    unittest.main()
