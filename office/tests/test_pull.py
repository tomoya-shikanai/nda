"""工場の Pi の送り箱へ取りに行く（box.pull）の試験。SSH は偽物（門番の 3 つの頼みを真似る）。"""

import json
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

from box.pull import MAX_FILE_BYTES, PullConfig, Puller, load_pull_config, ssh_argv

CFG = PullConfig(host="nda-pi.local", user="nda-pull", key_file=r"C:\k\pi-key", known_hosts=r"C:\k\known_hosts")


class FakePi:
    """門番（deploy/pi/nda-outbox-gate.sh）の真似。files は名前 → 中身。"""

    def __init__(self, files=None):
        self.files = dict(files or {})
        self.sent = {}
        self.calls = []
        self.fail = set()  # 失敗させる頼み（"list"・"get"・"ack"）

    def __call__(self, c, remote):
        self.calls.append(remote)
        verb, _, name = remote.partition(" ")
        if verb in self.fail:
            return 255, b""
        if verb == "list":
            return 0, "".join(n + "\n" for n in sorted(self.files)).encode("ascii")
        if verb == "get":
            return (0, self.files[name]) if name in self.files else (4, b"")
        if verb == "ack":
            if name in self.files:
                self.sent[name] = self.files.pop(name)
            return 0, b""
        return 64, b""


def message(rid=None, **over):
    rid = rid or str(uuid.uuid4())
    m = {"v": 1, "id": rid, "sessionId": "s-1", "kind": "estimate.instruction"}
    m.update(over)
    return rid, json.dumps(m).encode("utf-8")


class PullTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.root = Path(self.d.name)
        for n in ("in", "work", "done"):
            (self.root / n).mkdir()
        self.logs = []

    def tearDown(self):
        self.d.cleanup()

    def puller(self, pi, clock=None):
        return Puller(self.root, CFG, self.logs.append, call=pi, **({"clock": clock} if clock else {}))

    def test_pulls_places_marks_and_acks(self):
        rid, body = message()
        pi = FakePi({f"{rid}.json": body})
        self.assertEqual(self.puller(pi).pull_once(), 1)
        self.assertEqual((self.root / "in" / f"{rid}.json").read_bytes(), body)
        self.assertTrue((self.root / "done" / f"{rid}.pulled").exists())
        self.assertEqual(list(pi.sent), [f"{rid}.json"])
        self.assertEqual(list((self.root / "in").glob(".*")), [])  # 一時のファイルが残らない
        self.assertFalse(any(body.decode() in m for m in self.logs))

    def test_already_have_only_acks(self):
        for where in ("in", "work", "done-record", "pulled"):
            with self.subTest(where=where):
                rid, body = message()
                name = f"{rid}.json"
                if where in ("in", "work"):
                    (self.root / where / name).write_bytes(body)
                elif where == "done-record":
                    (self.root / "done" / f"{rid}.json").write_text("{}", encoding="utf-8")
                else:
                    (self.root / "done" / f"{rid}.pulled").write_text("x", encoding="ascii")
                pi = FakePi({name: body})
                self.assertEqual(self.puller(pi).pull_once(), 0)
                self.assertNotIn(f"get {name}", pi.calls)
                self.assertIn(name, pi.sent)

    def test_ack_failure_then_next_round_acks_without_second_copy(self):
        rid, body = message()
        name = f"{rid}.json"
        pi = FakePi({name: body})
        pi.fail = {"ack"}
        p = self.puller(pi)
        self.assertEqual(p.pull_once(), 1)
        (self.root / "in" / name).unlink()  # 受け箱が拾って処理した後（印は done に残る）
        pi.fail = set()
        self.assertEqual(p.pull_once(), 0)
        self.assertEqual(list(pi.sent), [name])
        self.assertFalse((self.root / "in" / name).exists())

    def test_rejects_bad_content_and_names(self):
        rid, _ = message()
        other, body_other = message()
        big_id = str(uuid.uuid4())
        files = {
            f"{rid}.json": json.dumps({"id": other}).encode(),  # 中の id が違う
            f"{other}.json": b"\xff\xfe",  # JSON でない
            f"{big_id}.json": b'{"id":"' + big_id.encode() + b'","x":"' + b"a" * MAX_FILE_BYTES + b'"}',
        }
        pi = FakePi(files)
        pi.files["../evil.json"] = body_other  # 名前の形が違う（門番は出さないはずだが、出ても取らない）
        p = self.puller(pi)
        self.assertEqual(p.pull_once(), 0)
        self.assertEqual(list((self.root / "in").iterdir()), [])
        self.assertEqual(pi.sent, {})
        self.assertNotIn("get ../evil.json", pi.calls)
        n = len(self.logs)
        p.pull_once()  # 同じ悪いファイルを何度もログに出さない
        self.assertEqual(len([m for m in self.logs[n:] if "取らない（" in m]), 0)

    def test_tick_interval_and_failures_do_not_raise(self):
        t = [0.0]
        rid, body = message()
        pi = FakePi({f"{rid}.json": body})
        pi.fail = {"list"}
        p = self.puller(pi, clock=lambda: t[0])
        self.assertEqual(p.tick(), 0)
        self.assertEqual(p.tick(), 0)  # 間隔の前は取りに行かない
        self.assertEqual(pi.calls, ["list"])
        self.assertEqual(len([m for m in self.logs if "届かない" in m]), 1)
        t[0] = 3.0
        p.tick()
        self.assertEqual(len([m for m in self.logs if "届かない" in m]), 1)  # 同じ失敗は 1 回だけ出す
        pi.fail = set()
        t[0] = 6.0
        self.assertEqual(p.tick(), 1)
        self.assertTrue(any("つながった" in m for m in self.logs))

        def boom(c, r):
            raise subprocess.TimeoutExpired("ssh", 15)
        t[0] = 9.0
        p.call = boom
        self.assertEqual(p.tick(), 0)


class HostileTest(PullTest):
    def test_deep_json_does_not_escape(self):
        rid = str(uuid.uuid4())
        pi = FakePi({f"{rid}.json": b"[" * 100000 + b"0" + b"]" * 100000})
        p = self.puller(pi)
        self.assertEqual(p.pull_once(), 0)
        self.assertEqual(pi.sent, {})

    def test_run_ssh_stops_reading_at_limit(self):
        import sys
        from box import pull

        orig = pull.ssh_argv
        try:
            pull.ssh_argv = lambda c, r, e: [sys.executable, "-c",
                                             "import sys\nwhile True: sys.stdout.buffer.write(b'a' * 65536)"]
            code, out = pull.run_ssh(CFG, "get x")
            self.assertEqual((code, len(out)), (0, MAX_FILE_BYTES + 1))
            pull.ssh_argv = lambda c, r, e: [sys.executable, "-c", "import sys; print('ok'); sys.exit(3)"]
            code, out = pull.run_ssh(CFG, "list")
            self.assertEqual((code, out.strip()), (3, b"ok"))
        finally:
            pull.ssh_argv = orig


class ConfigTest(unittest.TestCase):
    def test_load(self):
        self.assertIsNone(load_pull_config(None))
        c = load_pull_config({"host": "nda-pi.local", "user": "nda-pull", "key_file": "k", "known_hosts": "h"})
        self.assertEqual(c.interval_s, 3.0)
        bad = [[], {"host": "a b", "user": "u", "key_file": "k", "known_hosts": "h"},
               {"host": "-oProxyCommand=x", "user": "u", "key_file": "k", "known_hosts": "h"},
               {"host": "h", "user": "Root;x", "key_file": "k", "known_hosts": "h"},
               {"host": "h", "user": "u", "key_file": "-k", "known_hosts": "h"},
               {"host": "h", "user": "u", "key_file": "k", "known_hosts": "h", "interval_s": 0.5},
               {"host": "h", "user": "u", "key_file": "k", "known_hosts": "h", "interval_s": True},
               {"host": "h", "user": "u", "key_file": "k", "known_hosts": "h", "extra": 1}]
        for b in bad:
            with self.subTest(b=b), self.assertRaises(ValueError):
                load_pull_config(b)

    def test_ssh_argv_is_locked_down(self):
        a = ssh_argv(CFG, "list", "ssh.exe")
        for opt in ("BatchMode=yes", "StrictHostKeyChecking=yes", "IdentitiesOnly=yes", "ClearAllForwardings=yes",
                    "HostKeyAlias=nda-pi", "PermitLocalCommand=no"):
            self.assertIn(opt, a)
        self.assertEqual(a[-3:], ["--", "nda-pi.local", "list"])
        self.assertIn("none", a[a.index("-F") + 1])


if __name__ == "__main__":
    unittest.main()
