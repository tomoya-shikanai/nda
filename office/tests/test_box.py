"""事務所の受け箱（box）の試験。一時フォルダと偽の画面だけを使い、本物の窓・工場には何も送らない。"""

import copy
import json
import shutil
import tempfile
import unittest
import uuid
from decimal import Decimal
from pathlib import Path

from box import __main__ as boxmain
from box.inbox import Abort, Hooks, Inbox
from box.message import Reject, check_request, load_config
from inputter import send
from test_inputter_send import FakeDesktop, kp

CFG = load_config({
    "allowed_customers": ["9001"],
    "item_codes": {"架空の部品A": 101, "架空の部品B": 2345},
})
WHERE = {"recordingId": "rec-1", "startSec": 1.0, "endSec": 2.0, "quote": "＊＊さんの、部品A 4本"}


def request(**over):
    lines = over.pop("lines") if "lines" in over else [
        {"item": "架空の部品A", "qty": 4, "unit": "本", "unitPrice": 7777, "amount": 31108,
         "unitPriceFrom": "ledger", "provenance": WHERE},
        {"item": "架空の部品B", "qty": Decimal("1.5"), "unit": "L", "unitPrice": 1234, "amount": 1851,
         "unitPriceFrom": "spoken", "provenance": WHERE},
    ]
    msg = {
        "v": 1, "id": str(uuid.uuid4()), "sessionId": "s-1", "sentAt": "2026-11-07T01:02:03.000Z",
        "kind": "invoice.request", "attempt": 1,
        "customer": {"customerNo": "9001", "carNo": "9002"},
        "approvedAt": "2026-11-07T01:02:00Z", "approval": WHERE,
        "lines": lines, "total": sum(l["amount"] for l in lines if isinstance(l, dict)), "totalSpoken": None,
    }
    msg.update(over)
    return msg


class CheckTest(unittest.TestCase):
    def test_good_request_becomes_job(self):
        job = check_request(request(), CFG)
        self.assertEqual(job["customer_code"], 9001)
        self.assertEqual(job["car_code"], 9002)
        self.assertEqual([l["item"] for l in job["lines"]], ["架空の部品A", "架空の部品B"])

    def test_rejects(self):
        def line(**o):
            l = copy.deepcopy(request()["lines"][0])
            l.update(o)
            return l

        cases = {
            "invalid": [
                request(v=2), request(id="abc"), request(sessionId="../x"), request(attempt=0),
                request(lines=[line(qty=None)]), request(lines=[line(unitPrice=None)]),
                request(lines=[line(amount=31107)]), request(total=1),
                request(lines=[line(qty=Decimal("0.05"), amount=0)]),
                request(lines=[line(unitPrice=Decimal("7777.5"))]),
                request(lines=[line(unitPriceFrom="guess")]),
                request(customer={"customerNo": "abc", "carNo": "9002"}),
                request(kind="customer.query"), request(extra=1),
                request(lines=[]),
            ],
            "customerNotAllowed": [request(customer={"customerNo": "9003", "carNo": "9002"})],
            "unknownItem": [request(lines=[line(item="知らない品目")])],
        }
        for reason, msgs in cases.items():
            for m in msgs:
                with self.subTest(reason=reason, m=m), self.assertRaises(Reject) as cm:
                    check_request(m, CFG)
                self.assertEqual(cm.exception.reason, reason)
                self.assertNotIn("9001", str(cm.exception))
                self.assertNotIn("7777", str(cm.exception))

    def test_config_refused(self):
        for bad in ({}, {"allowed_customers": [9001], "item_codes": {"a": 1}},
                    {"allowed_customers": ["1"], "item_codes": {"a": -1}},
                    {"allowed_customers": ["1"], "item_codes": {"a": 1}, "pi_url": "http://x/api/office/reply"},
                    {"allowed_customers": ["1"], "item_codes": {"a": 1}, "pi_url": "http://x/other", "secret": "s" * 16}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                load_config(bad)


class FakeHooks:
    def __init__(self, confirm=True, enter=None):
        self.prepared, self.entered, self.posted, self.logs = [], [], [], []
        self._confirm = confirm
        self._enter = enter

    def hooks(self):
        def prepare(job):
            self.prepared.append(job)
            return job

        def enter(job):
            if self._enter:
                return self._enter(job)
            self.entered.append(job)
            return len(job["lines"])

        return Hooks(prepare=prepare, confirm=lambda job: self._confirm, enter=enter,
                     post=lambda r: self.posted.append(r) or "posted", log=self.logs.append)


class InboxTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "in").mkdir()
        self.fh = FakeHooks()
        self.box = Inbox(self.root, CFG, self.fh.hooks())

    def tearDown(self):
        shutil.rmtree(self.root)

    def put(self, msg, name=None):
        p = self.root / "in" / (name or f"invoice.request-{msg['sessionId']}-{msg['id']}.json")
        p.write_text(json.dumps(msg, ensure_ascii=False, default=float), encoding="utf-8")
        return p

    def state(self, sid="s-1"):
        return json.loads((self.root / "done" / f"{sid}.state.json").read_text(encoding="utf-8"))

    def test_entered_once(self):
        m = request()
        self.put(m)
        self.assertEqual(self.box.run_once(), 1)
        self.assertEqual(len(self.fh.entered), 1)
        r = self.fh.posted[-1]
        self.assertEqual((r["kind"], r["outcome"], r["enteredLines"], r["requestId"]), ("invoice.result", "entered", 2, m["id"]))
        self.assertEqual(self.state()["status"], "entered")
        self.assertEqual(list((self.root / "in").iterdir()), [])
        self.assertEqual(list((self.root / "work").iterdir()), [])
        self.assertTrue((self.root / "done" / f"{m['id']}.request.json").exists())

    def test_same_file_twice_reposts_without_entering(self):
        m = request()
        self.put(m)
        self.box.run_once()
        self.put(m)
        self.box.run_once()
        self.assertEqual(len(self.fh.entered), 1)
        self.assertEqual(len(self.fh.posted), 2)
        self.assertEqual(self.fh.posted[0]["id"], self.fh.posted[1]["id"])  # 記録した答えをそのまま返す

    def test_same_session_new_id_is_duplicate(self):
        self.put(request())
        self.box.run_once()
        self.put(request())
        self.box.run_once()
        self.assertEqual(len(self.fh.entered), 1)
        self.assertEqual((self.fh.posted[-1]["outcome"], self.fh.posted[-1]["reason"]), ("stopped", "duplicate"))
        self.assertEqual(self.state()["status"], "entered")

    def test_retry_after_stop_needs_next_attempt(self):
        self.fh._confirm = False
        self.put(request())
        self.box.run_once()
        self.assertEqual(self.state()["status"], "stopped")
        self.fh._confirm = True
        self.put(request(attempt=3))  # 飛ばした attempt は受けない
        self.box.run_once()
        self.assertEqual(self.fh.posted[-1]["reason"], "duplicate")
        self.put(request(attempt=2))
        self.box.run_once()
        self.assertEqual(self.fh.posted[-1]["outcome"], "entered")
        self.assertEqual(len(self.fh.entered), 1)

    def test_first_attempt_must_be_1(self):
        self.put(request(attempt=2))
        self.box.run_once()
        self.assertEqual(self.fh.entered, [])
        self.assertEqual(self.fh.posted[-1]["reason"], "duplicate")

    def test_invalid_does_not_prepare_or_enter(self):
        self.put(request(total=1))
        self.box.run_once()
        self.assertEqual((self.fh.prepared, self.fh.entered), ([], []))
        self.assertEqual((self.fh.posted[-1]["outcome"], self.fh.posted[-1]["reason"]), ("stopped", "invalid"))

    def test_operator_declines(self):
        self.fh._confirm = False
        self.put(request())
        self.box.run_once()
        self.assertEqual(self.fh.entered, [])
        self.assertEqual(self.fh.posted[-1]["outcome"], "stopped")

    def test_enter_failure_is_stopped_without_values(self):
        def boom(job):
            raise RuntimeError("7777 9001")

        self.fh._enter = boom
        self.put(request())
        self.box.run_once()
        r = self.fh.posted[-1]
        self.assertEqual((r["outcome"], r["reason"]), ("stopped", "other"))
        rec = (self.root / "done" / f"{r['requestId']}.json").read_text(encoding="utf-8")
        self.assertNotIn("7777", rec)
        self.assertNotIn("7777", "\n".join(self.fh.logs))

    def test_abort_reason_passes_through(self):
        def stop(job):
            raise Abort("readbackMismatch", "読み返しが合わない")

        self.fh._enter = stop
        self.put(request())
        self.box.run_once()
        self.assertEqual(self.fh.posted[-1]["reason"], "readbackMismatch")

    def test_other_kinds_and_tmp_files_are_left(self):
        q = {"v": 1, "id": str(uuid.uuid4()), "sessionId": "s-2", "sentAt": "2026-11-07T01:02:03Z", "kind": "customer.query"}
        pq = self.put(q, "customer.query-s-2.json")
        pt = self.put(request(), ".invoice.request-x.json.tmp")
        self.assertEqual(self.box.run_once(), 0)
        self.assertTrue(pq.exists() and pt.exists())
        self.assertEqual(self.fh.posted, [])

    def test_unreadable_is_set_aside(self):
        p = self.root / "in" / "bad.json"
        p.write_text("{not json", encoding="utf-8")
        self.box.run_once()
        self.assertFalse(p.exists())
        self.assertEqual(len(list((self.root / "done").glob("unreadable-*.json"))), 1)
        dup = self.root / "in" / "dupkey.json"
        dup.write_text('{"v": 1, "v": 1}', encoding="utf-8")
        self.box.run_once()
        self.assertEqual(len(list((self.root / "done").glob("unreadable-*.json"))), 2)

    def test_recover_stops_leftovers_without_entering(self):
        m = request()
        (self.root / "work").mkdir(exist_ok=True)
        (self.root / "work" / "x.json").write_text(json.dumps(m, default=float), encoding="utf-8")
        self.box.recover()
        self.assertEqual(self.fh.entered, [])
        self.assertEqual((self.fh.posted[-1]["outcome"], self.fh.posted[-1]["reason"]), ("stopped", "other"))
        self.assertEqual(self.state()["status"], "stopped")
        # 止めた後は attempt 2 で入れ直せる
        self.put(request(attempt=2))
        self.box.run_once()
        self.assertEqual(self.fh.posted[-1]["outcome"], "entered")

    def test_resend_failed_posts(self):
        fails = []
        hooks = self.fh.hooks()
        hooks.post = lambda r: fails.append(r) or "failed"
        box = Inbox(self.root, CFG, hooks)
        self.put(request())
        box.run_once()
        hooks.post = lambda r: fails.append(r) or "posted"
        box.resend()
        self.assertEqual(len(fails), 2)
        self.assertEqual(fails[0]["id"], fails[1]["id"])
        box.resend()
        self.assertEqual(len(fails), 2)


class CodexFixTest(unittest.TestCase):
    """Codex の 1 回目の指摘の再現。"""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "in").mkdir()
        self.fh = FakeHooks()
        self.closed = []
        hooks = self.fh.hooks()
        hooks.closed = lambda: self.closed.append(1)
        self.hooks = hooks
        self.box = Inbox(self.root, CFG, hooks)

    def tearDown(self):
        if getattr(self.box, "_lockf", None):
            self.box._lockf.close()
        shutil.rmtree(self.root)

    def write(self, text, name="r.json"):
        p = self.root / "in" / name
        p.write_text(text, encoding="utf-8")
        return p

    def test_bad_datetime_and_nan(self):
        with self.assertRaises(Reject):
            check_request(request(approvedAt="2026-99-99T99:99:99Z"), CFG)
        bad = json.dumps(request(), default=float).replace('"startSec": 1.0', '"startSec": NaN', 1)
        self.write(bad)
        self.box.run_once()
        self.assertEqual(self.fh.entered, [])
        self.assertEqual(len(list((self.root / "done").glob("unreadable-*.json"))), 1)

    def test_huge_exponent_qty_is_rejected_fast(self):
        m = json.dumps(request(), default=float).replace('"qty": 4,', '"qty": 1e999999999,', 1)
        self.write(m)
        self.box.run_once()
        self.assertEqual(self.fh.entered, [])
        self.assertEqual(self.fh.posted[-1]["reason"], "invalid")

    def test_deep_nesting_does_not_kill_loop(self):
        self.write("[" * 100000 + "0" + "]" * 100000, "a.json")
        self.write(json.dumps(request(), default=float), "b.json")
        self.box.run_once()
        self.assertEqual(len(self.fh.entered), 1)

    def test_second_watcher_refused(self):
        self.box.lock()
        other = Inbox(self.root, CFG, self.fh.hooks())
        with self.assertRaises(RuntimeError):
            other.lock()

    def test_closed_waited_before_stopped_after_send_began(self):
        order = []

        def boom(job):
            raise RuntimeError("x")

        self.fh._enter = boom
        self.hooks.closed = lambda: order.append("closed")
        post = self.hooks.post
        self.hooks.post = lambda r: order.append(r["outcome"]) or post(r)
        self.write(json.dumps(request(), default=float))
        self.box.run_once()
        self.assertEqual(order, ["closed", "stopped"])

    def test_decline_does_not_wait_closed(self):
        self.fh._confirm = False
        self.write(json.dumps(request(), default=float))
        self.box.run_once()
        self.assertEqual(self.closed, [])

    def test_failed_post_is_resent_while_running(self):
        import box.inbox as inbox_mod

        calls = []
        self.hooks.post = lambda r: calls.append(r) or "failed"
        self.write(json.dumps(request(), default=float))
        self.box.run_once()
        self.hooks.post = lambda r: calls.append(r) or "posted"
        self.box.last_resend -= inbox_mod.RESEND_EVERY_S
        self.box.run_once()
        self.assertEqual(len(calls), 2)

    def test_send_needs_confirmed_per_request(self):
        # リポジトリの keypath・columns は未確認なので、送る形の手順は作らない
        with self.assertRaises(RuntimeError):
            boxmain._plan(check_request(request(), CFG), CFG, need_confirmed=True)


class EndToEndTest(unittest.TestCase):
    """受け箱 → 確かめ → 手順 → 偽の伝票の画面に送る、の一周。"""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        (self.root / "in").mkdir()

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_request_reaches_fake_screen(self):
        k = kp()
        desk = FakeDesktop(k)
        posted = []

        def enter(prepared):
            kpath, _, groups = prepared
            send.run(desk, kpath, groups, lambda m: None)
            return len(groups) // len(kpath.path)

        hooks = Hooks(prepare=lambda job: boxmain._plan(job, CFG), confirm=lambda job: True, enter=enter,
                      post=lambda r: posted.append(r) or "noPi", log=lambda m: None)
        box = Inbox(self.root, CFG, hooks)
        m = request()
        (self.root / "in" / "r.json").write_text(json.dumps(m, default=float), encoding="utf-8")
        box.run_once()
        expected = []
        for code, qty, price in (("101", "4", "7777"), ("2345", "1.5", "1234")):
            expected += [("char", c) for c in code] + [("key", "Enter")] * 4
            expected += [("char", c) for c in qty] + [("key", "Enter")]
            expected += [("char", c) for c in price] + [("key", "Enter")]
        self.assertEqual(desk.sent, expected)
        self.assertEqual((posted[-1]["outcome"], posted[-1]["enteredLines"]), ("entered", 2))

    def test_send_stop_becomes_stopped(self):
        k = kp()
        desk = FakeDesktop(k)
        desk.extra_windows.append(send.TopWindow(hwnd=5, class_name="#32770", title="確認"))
        posted = []

        def enter(prepared):
            kpath, _, groups = prepared
            try:
                send.run(desk, kpath, groups, lambda m: None)
            except send.Stop:
                raise Abort("other", "止まった") from None
            return 2

        hooks = Hooks(prepare=lambda job: boxmain._plan(job, CFG), confirm=lambda job: True, enter=enter,
                      post=lambda r: posted.append(r) or "noPi", log=lambda m: None)
        box = Inbox(self.root, CFG, hooks)
        (self.root / "in" / "r.json").write_text(json.dumps(request(), default=float), encoding="utf-8")
        box.run_once()
        self.assertEqual(desk.sent, [])
        self.assertEqual(posted[-1]["outcome"], "stopped")


if __name__ == "__main__":
    unittest.main()
