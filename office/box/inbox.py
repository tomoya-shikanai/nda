"""事務所の受け箱（docs/design/pi-office.md §3）。Windows に依存しない部分。

置き場（root、既定は C:\\nda\\box）:
  in\\    工場が置く。*.json だけ拾う（.tmp や . で始まるものは書きかけなので拾わない）
  work\\  拾って処理中。始めたときにここにあるものは、途中で落ちたものなので stopped: other にする（続きは入れない）
  done\\  <id>.json（処理の記録と返した答え）、<id>.request.json（届いたファイル）、session-<sessionId>.state.json（二重入力の鍵）
  dry\\   ドライランの記録（受け箱の状態は変えない）

ここで扱うのは invoice.request だけ。customer.query（照合）は別の部品が扱うので、拾わずに残す。
画面に送る・人に確かめる・工場に返すところは、呼ぶ側が関数で渡す（試験では偽物）。
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .message import Reject, check_instruction, check_request, envelope, read_message

MAX_FILE_BYTES = 256 * 1024
RESEND_EVERY_S = 30  # 工場に返せていない答えを送り直す間隔（24 時間まで）


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def write_json(path: Path, data: object) -> None:
    """書きかけを読まれないよう、.tmp に書いて名前を変える。"""
    tmp = path.with_name("." + path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    os.replace(tmp, path)


def result_message(session_id: str, request_id: str, outcome: str, entered: int, reason: str | None) -> dict:
    """invoice.result（pi-office.md §3）。読み返しの値と写真は、今は返さない（null）。"""
    return {
        "v": 1,
        "id": str(uuid.uuid4()),
        "sessionId": session_id,
        "sentAt": now_iso(),
        "kind": "invoice.result",
        "requestId": request_id,
        "outcome": outcome,
        "enteredLines": entered,
        "reason": reason,
        "readback": None,
        "screenshotFile": None,
    }


class Abort(Exception):
    """人がやめた・入力が途中で止まった。文には値を入れない。"""

    def __init__(self, reason: str, why: str) -> None:
        super().__init__(why)
        self.reason = reason


@dataclass
class Hooks:
    """呼ぶ側が渡す部分。どれも値（品目・客の番号）をログに出さないこと。"""

    prepare: Callable[[dict], object]  # job → 送る手順。作れなければ例外（何も送っていない）
    confirm: Callable[[dict], bool]  # 人が正しい客の伝票を開いたか。False ならやめる（何も送っていない）
    enter: Callable[[object], int]  # 手順を送り、入れた行の数を返す。止まれば Abort か例外
    post: Callable[[dict], str]  # 工場に返す。"posted" / "noPi" / "failed" / "unauthorized"
    log: Callable[[str], None]
    # 送り始めた後に止まったとき、人が伝票を保存せずに閉じるまで待つ。閉じてから stopped を返す（pi-office.md §3）
    closed: Callable[[], None] = lambda: None


class Inbox:
    def __init__(self, root: Path, cfg: dict, hooks: Hooks, resolve_vehicle=None) -> None:
        self.root = Path(root)
        self.resolve_vehicle = resolve_vehicle  # 声の指示（estimate.instruction）の客と車を決める（--auto のときだけ）
        self.cfg = cfg
        self.h = hooks
        self.inbox = self.root / "in"
        self.work = self.root / "work"
        self.done = self.root / "done"
        if not self.inbox.is_dir():
            raise FileNotFoundError(f"受け箱が無い: {self.inbox}")
        self.work.mkdir(exist_ok=True)
        self.done.mkdir(exist_ok=True)
        self.broken: set[str] = set()
        self.last_resend = time.time()

    # --- 拾う ---------------------------------------------------------------

    def pending(self) -> list[Path]:
        out = []
        for p in sorted(self.inbox.iterdir(), key=lambda p: p.name):
            if p.name.startswith(".") or p.suffix != ".json" or not p.is_file():
                continue
            out.append(p)
        return out

    def _read(self, p: Path) -> object:
        return read_message(p, MAX_FILE_BYTES)

    def _set_aside(self, p: Path, why: str) -> None:
        """id の分からないファイルは、工場に返せないので、done に脇へ寄せて残すだけ。"""
        dest = self.done / f"unreadable-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.json"
        try:
            os.replace(p, dest)
        except FileNotFoundError:
            return
        self.h.log(f"読めないファイルを脇へ寄せた（{why}）→ {dest.name}")

    # --- 状態 ---------------------------------------------------------------

    def _state_path(self, session_id: str) -> Path:
        # 頭に session- を付ける。CON・NUL などの Windows の予約名がファイル名にならないように（Codex 3 回目）
        return self.done / f"session-{session_id}.state.json"

    def state(self, session_id: str) -> dict | None:
        p = self._state_path(session_id)
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    def _set_state(self, session_id: str, **kw) -> None:
        write_json(self._state_path(session_id), {**kw, "at": now_iso()})

    def record(self, request_id: str) -> dict | None:
        p = self.done / f"{request_id}.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    # --- 始めるとき -----------------------------------------------------------

    def recover(self) -> None:
        """work に残っているもの（途中で落ちた）は、続きを入れずに stopped: other にする。"""
        for p in sorted(self.work.glob("*.json")):
            try:
                msg = read_message(p, MAX_FILE_BYTES)
                kind, rid, sid = envelope(msg)
            except Exception:
                self._set_aside(p, "work に残っていた読めないファイル")
                continue
            if self.record(rid) is None:
                attempt = msg.get("attempt") if isinstance(msg.get("attempt"), int) else 0
                st = self.state(sid)
                if st is not None and st.get("requestId") != rid:
                    # 同じ作業の別の依頼の状態（入れ終えた・入れている）は書き換えない。
                    # 書き換えると attempt+1 で入れ直せてしまう（Codex 3 回目）
                    self._finish(p, sid, rid, "stopped", 0, "duplicate", "前に処理の途中で止まっていた（同じ作業はほかの依頼で受けている）")
                elif st is not None and st.get("status") == "entered":
                    # 入れ終えた後、記録を書く前に落ちた。答えは entered のまま返す
                    self._finish(p, sid, rid, "entered", int(st.get("lines", 0)), None, "保存の手前まで入れた（記録は再起動の後に書いた）")
                else:
                    if st is not None and st.get("status") == "entering":
                        # 送っている途中で落ちたかもしれない。入れかけの伝票を人が閉じるまで stopped を返さない（Codex 2 回目）
                        self.h.log(f"{rid[:8]} 前に入力の途中で止まっていた依頼がある")
                        self.h.closed()
                    self._set_state(sid, status="stopped", attempt=attempt, requestId=rid)
                    self._finish(p, sid, rid, "stopped", 0, "other", "前に処理の途中で止まっていた")
            else:
                os.replace(p, self.done / f"{rid}.request.json")

    def resend(self) -> None:
        """工場に返せていない答えを送り直す（24 時間まで）。"""
        limit = time.time() - 24 * 3600
        for p in sorted(self.done.glob("*.json")):
            if p.name.endswith((".state.json", ".request.json")) or p.name.startswith("unreadable-"):
                continue
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            # 期限は記録を作った時刻で見る（ファイルの更新時刻は再送のたびに変わる。Codex 2 回目）
            created = rec.get("createdAt")
            if rec.get("posted") in ("failed", None) and isinstance(created, (int, float)) and created >= limit:
                rec["posted"] = self.h.post(rec["result"])
                write_json(p, rec)

    # --- 1 件の処理 -----------------------------------------------------------

    def _finish(self, work_path: Path, sid: str, rid: str, outcome: str, entered: int, reason: str | None, why: str) -> dict:
        result = result_message(sid, rid, outcome, entered, reason)
        rec = {"requestId": rid, "sessionId": sid, "why": why, "result": result, "posted": None, "createdAt": time.time()}
        write_json(self.done / f"{rid}.json", rec)
        if work_path.exists():
            os.replace(work_path, self.done / f"{rid}.request.json")
        rec["posted"] = self.h.post(result)
        write_json(self.done / f"{rid}.json", rec)
        # sessionId は工場が付けた文字列で、値が入り得るのでログに出さない（Codex 2 回目）。id の頭だけ出す
        self.h.log(f"{rid[:8]}: {outcome}" + (f"（{reason}: {why}）" if reason else "") + f" 工場へ: {rec['posted']}")
        return rec

    def handle(self, p: Path) -> dict | None:
        """受け箱の 1 ファイルを処理する。拾わなかったもの（ほかの種類）は None。"""
        try:
            msg = self._read(p)
            kind, rid, sid = envelope(msg)
        except FileNotFoundError:
            return None
        except Reject as ex:
            self._set_aside(p, str(ex))
            return None
        if kind not in ("invoice.request", "estimate.instruction"):
            return None  # 照合などは別の部品が拾う
        if kind == "estimate.instruction" and self.resolve_vehicle is None:
            return None  # 声の指示は --auto の見回りだけが拾う（残しておく）

        prev = self.record(rid)
        if prev is not None:
            # 同じファイルが 2 回届いた。何もせず、記録した答えをもう一度返す
            try:
                os.replace(p, self.done / f"{rid}.dup-{uuid.uuid4().hex[:8]}.request.json")
            except FileNotFoundError:
                pass
            prev["posted"] = self.h.post(prev["result"])
            write_json(self.done / f"{rid}.json", prev)
            self.h.log(f"{rid[:8]} 同じ依頼がもう一度届いた。前の答えを返し直した")
            return prev

        w = self.work / p.name
        try:
            os.replace(p, w)  # 拾った印。ほかの見回りと取り合わない
        except FileNotFoundError:
            return None

        attempt = msg.get("attempt")
        st = self.state(sid)
        if st is None:
            ok = attempt == 1
        else:
            ok = st.get("status") == "stopped" and isinstance(attempt, int) and attempt == st.get("attempt", 0) + 1
        if not ok:
            # 同じ作業はすでに入れたか入れている。画面に触らない（状態は変えない）
            return self._finish(w, sid, rid, "stopped", 0, "duplicate", "この作業はすでに受けている")

        try:
            if kind == "estimate.instruction":
                job = check_instruction(msg, self.cfg, self.resolve_vehicle)
            else:
                job = check_request(msg, self.cfg)
        except Reject as ex:
            self._set_state(sid, status="stopped", attempt=attempt if isinstance(attempt, int) else 0, requestId=rid)
            return self._finish(w, sid, rid, "stopped", 0, ex.reason, str(ex))

        self._set_state(sid, status="entering", attempt=attempt, requestId=rid)
        try:
            prepared = self.h.prepare(job)
        except Exception as ex:  # 手順を作れない（設定・欄の誤り）。文には値が入り得るので型だけ
            self._set_state(sid, status="stopped", attempt=attempt, requestId=rid)
            return self._finish(w, sid, rid, "stopped", 0, "invalid", f"入れる手順を作れない（{type(ex).__name__}）")
        try:
            ok = self.h.confirm(job)
        except Exception as ex:
            ok = False
            self.h.log(f"人の確かめを読めなかった（{type(ex).__name__}）")
        if not ok:
            self._set_state(sid, status="stopped", attempt=attempt, requestId=rid)
            return self._finish(w, sid, rid, "stopped", 0, "other", "人が入力をやめた（何も送っていない）")
        try:
            entered = self.h.enter(prepared)
        except BaseException as ex:  # 送っている途中で止まった（Ctrl+C も）。文は出さない（値が入り得る）
            reason = ex.reason if isinstance(ex, Abort) else "other"
            why = str(ex) if isinstance(ex, Abort) else f"入力が途中で止まった（{type(ex).__name__}）"
            # 入れかけの伝票が開いたまま stopped を返すと、次の attempt が同じ伝票に重なる（Codex の指摘）。
            # 人が保存せずに閉じるまで、状態は entering のまま待つ。待つ間に落ちても、work に残るので入れ直さない
            self.h.closed()
            self._set_state(sid, status="stopped", attempt=attempt, requestId=rid)
            self._finish(w, sid, rid, "stopped", 0, reason, why + "。伝票は保存せずに閉じた")
            if not isinstance(ex, Exception):
                raise
            return self.record(rid)
        self._set_state(sid, status="entered", attempt=attempt, requestId=rid, lines=entered)
        return self._finish(w, sid, rid, "entered", entered, None, "保存の手前まで入れた。保存は人が押す")

    def run_once(self) -> int:
        n = 0
        for p in self.pending():
            if p.name in self.broken:
                continue
            try:
                if self.handle(p) is not None:
                    n += 1
            except Exception as ex:  # 1 ファイルの思わぬ失敗で見回りを止めない。ファイル名・文は出さない（値が入り得る）
                self.broken.add(p.name)
                self.h.log(f"受け箱のファイルを処理できなかった（{type(ex).__name__}）。人が見てください")
        if time.time() - self.last_resend >= RESEND_EVERY_S:
            self.last_resend = time.time()
            self.resend()
        return n

    def lock(self) -> None:
        """同じ受け箱を 2 つの見回りが扱うと、同じ作業を 2 回入れ得る（Codex の指摘）。1 つだけにする。"""
        self._lockf = open(self.root / ".box.lock", "a+b")
        try:
            if sys.platform == "win32":
                import msvcrt

                self._lockf.seek(0)
                msvcrt.locking(self._lockf.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._lockf.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self._lockf.close()
            raise RuntimeError("ほかの見回りがこの受け箱を使っている") from None
