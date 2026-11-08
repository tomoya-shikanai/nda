"""工場の Pi の送り箱から、承認済みの指示を事務所の受け箱へ取りに行く（#53。2026-11-08 鹿内さんの決定）。

向き: 事務所の PC から Pi へ SSH でつなぐだけ。事務所の PC は外からの接続を受けない（共有フォルダ・ファイアウォールを変えない）。
Pi 側は、この PC の鍵に「門番」（deploy/pi/nda-outbox-gate.sh、authorized_keys の command=）を付ける。
門番が受けるのは次の 3 つだけ。それ以外のコマンド・シェル・転送はできない。
  list          送り箱の <uuid>.json の名前を 1 行ずつ
  get <名前>    そのファイルの中身
  ack <名前>    受け取った印に、送り箱から sent/ へ移す

流れ（1 件ずつ）: get → 受け箱に一時の名前で書く → 名前を変えて置く → 取った印（done\\<id>.pulled）→ ack。
ack の前に落ちても、次の回に「もうある」と分かって ack だけする（2 回届いても受け箱が同じ id を 1 回しか入れない）。
中身はログに出さない。出すのは id の頭 8 文字と件数だけ。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .inbox import MAX_FILE_BYTES

NAME_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$")
HOST_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$")
USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
MAX_LIST = 50  # 1 回に取る数の上限
CALL_TIMEOUT_S = 15
HOST_ALIAS = "nda-pi"  # known_hosts は IP でなくこの名前で照らす（Pi の IP が変わっても鍵の確かめが続く）


@dataclass(frozen=True)
class PullConfig:
    host: str
    user: str
    key_file: str
    known_hosts: str
    interval_s: float = 3.0


def load_pull_config(data: object) -> PullConfig | None:
    """config.json の pi_pull。無ければ None（取りに行かない）。"""
    if data is None:
        return None
    if not isinstance(data, dict) or set(data) - {"host", "user", "key_file", "known_hosts", "interval_s"}:
        raise ValueError("pi_pull は {host, user, key_file, known_hosts, interval_s?} の形")
    host, user, key, kh = data.get("host"), data.get("user"), data.get("key_file"), data.get("known_hosts")
    if not isinstance(host, str) or not HOST_RE.match(host):
        raise ValueError("pi_pull.host は Pi の名前（例 <名前>.local）か IP")
    if not isinstance(user, str) or not USER_RE.match(user):
        raise ValueError("pi_pull.user は Pi のユーザー名")
    for name, v in (("key_file", key), ("known_hosts", kh)):
        if not isinstance(v, str) or not v or v.startswith("-"):
            raise ValueError(f"pi_pull.{name} はファイルの場所")
    iv = data.get("interval_s", 3)
    if isinstance(iv, bool) or not isinstance(iv, (int, float)) or not 1 <= iv <= 60:
        raise ValueError("pi_pull.interval_s は 1〜60 秒")
    return PullConfig(host=host, user=user, key_file=key, known_hosts=kh, interval_s=float(iv))


def ssh_exe() -> str:
    """Windows に入っている ssh.exe を場所で決めて使う（PATH の別の ssh を拾わない）。"""
    win = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "OpenSSH" / "ssh.exe"
    if win.is_file():
        return str(win)
    found = shutil.which("ssh")
    if not found:
        raise FileNotFoundError("ssh が無い")
    return found


def ssh_argv(c: PullConfig, remote: str, exe: str) -> list[str]:
    return [
        exe, "-T", "-i", c.key_file,
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
        "-o", f"UserKnownHostsFile={c.known_hosts}", "-o", "GlobalKnownHostsFile=none",
        "-o", "StrictHostKeyChecking=yes", "-o", f"HostKeyAlias={HOST_ALIAS}",
        "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
        "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no",
        "-o", "PermitLocalCommand=no", "-o", "LogLevel=ERROR", "-F", "none",
        "-l", c.user, "--", c.host, remote,
    ]


def run_ssh(c: PullConfig, remote: str) -> tuple[int, bytes]:
    """1 回つないで remote を頼み、(終わりの番号, 出力) を返す。
    出力は読みながら MAX_FILE_BYTES＋1 で打ち切る（全部をためてから切らない。Codex の指摘）。標準エラーは読まない。
    打ち切ったときは ssh を止め、(0, MAX_FILE_BYTES＋1 バイト) を返す（受け取る側が「大きすぎる」で断る）。"""
    argv = ssh_argv(c, remote, ssh_exe())
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         creationflags=flags)
    got: list[bytes] = []
    t = threading.Thread(target=lambda: got.append(p.stdout.read(MAX_FILE_BYTES + 1)), daemon=True)
    t.start()
    t.join(CALL_TIMEOUT_S)
    try:
        if t.is_alive():
            raise subprocess.TimeoutExpired(argv[0], CALL_TIMEOUT_S)
        out = got[0] if got else b""
        if len(out) > MAX_FILE_BYTES:
            return 0, out
        return p.wait(timeout=5), out
    finally:
        if p.poll() is None:
            p.kill()
            p.wait(timeout=5)
        p.stdout.close()


class Puller:
    def __init__(self, root: Path, c: PullConfig, log: Callable[[str], None],
                 call: Callable[[PullConfig, str], tuple[int, bytes]] = run_ssh, clock=time.monotonic) -> None:
        self.root = Path(root)
        self.inbox, self.work, self.done = self.root / "in", self.root / "work", self.root / "done"
        self.c, self.log, self.call, self.clock = c, log, call, clock
        self.next_at = 0.0
        self.ok: bool | None = None  # つながり方が変わったときだけログに出す
        self.bad: set[str] = set()  # 中身が合わなかった名前（同じ回で何度もログに出さない）

    def _have(self, name: str) -> bool:
        rid = name[: -len(".json")]
        return any(p.exists() for p in (self.inbox / name, self.work / name, self.done / f"{rid}.json",
                                         self.done / f"{rid}.pulled"))

    def _state(self, ok: bool, why: str = "") -> None:
        if ok != self.ok:
            self.log("工場の Pi につながった" if ok else f"工場の Pi に届かない（{why}）。間隔をおいて試し続ける")
        self.ok = ok

    def tick(self) -> int:
        """間隔が来ていれば 1 回取りに行く。受け箱に置いた件数を返す。落ちない（失敗はログに出して次の回）。"""
        now = self.clock()
        if now < self.next_at:
            return 0
        self.next_at = now + self.c.interval_s
        try:
            return self.pull_once()
        except subprocess.TimeoutExpired:
            self._state(False, "時間切れ")
        except OSError as ex:
            self._state(False, type(ex).__name__)
        except Exception as ex:  # 取りに行く部分の失敗で、受け箱の見回りまで止めない
            self.log(f"工場の Pi から取るところで思わぬ失敗（{type(ex).__name__}）。次の回にまた試す")
        return 0

    def pull_once(self) -> int:
        code, out = self.call(self.c, "list")
        if code != 0:
            self._state(False, f"list の終わりの番号 {code}")
            return 0
        self._state(True)
        try:
            lines = out.decode("ascii").splitlines()
        except UnicodeDecodeError:
            self.log("Pi の送り箱の一覧が読めない（ascii でない）。今回は取らない")
            return 0
        names = [n for n in lines if NAME_RE.match(n)]
        if len(names) != len([n for n in lines if n.strip()]):
            self.log("Pi の送り箱に、名前の形が違うものがある。それは取らない")
        self.bad &= set(names)  # 一覧から消えた名前は控えから外す（控えが増え続けない。Codex の指摘）
        placed = 0
        for name in sorted(set(names))[:MAX_LIST]:
            if self._have(name):
                self._ack(name)  # 前の回で置いたが ack できなかった
                continue
            if self._get(name):
                placed += 1
                self._ack(name)
        return placed

    def _get(self, name: str) -> bool:
        rid = name[: -len(".json")]
        code, data = self.call(self.c, f"get {name}")
        if code != 0:
            self._state(False, f"get の終わりの番号 {code}")
            return False
        why = None
        if len(data) > MAX_FILE_BYTES:
            why = "大きすぎる"
        else:
            try:
                msg = json.loads(data.decode("utf-8"))
                if not isinstance(msg, dict) or msg.get("id") != rid:
                    why = "中の id がファイル名と違う"
            except (UnicodeDecodeError, ValueError, RecursionError):  # 入れ子が深すぎる JSON も（Codex の指摘）
                why = "JSON でない"
        if why:
            if name not in self.bad:
                self.log(f"{rid[:8]} Pi の送り箱のファイルを取らない（{why}）。Pi 側で確かめる")
            self.bad.add(name)
            return False
        tmp = self.inbox / f".{name}.pull.tmp"  # . で始まる名前は受け箱が拾わない
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if self._have(name):  # 書いている間に、別の道で同じものが届いた
            tmp.unlink(missing_ok=True)
            return False
        os.replace(tmp, self.inbox / name)
        (self.done / f"{rid}.pulled").write_text(time.strftime("%Y-%m-%dT%H:%M:%S"), encoding="ascii")
        self.log(f"{rid[:8]} 工場の Pi から指示を受け取った")
        return True

    def _ack(self, name: str) -> None:
        code, _ = self.call(self.c, f"ack {name}")
        if code != 0:
            self._state(False, f"ack の終わりの番号 {code}")
