"""事務所の受け箱（docs/design/pi-office.md §3）。Windows に依存しない部分。

置き場（root、既定は C:\\nda\\box）:
  in\\    工場が置く。*.json だけ拾う（.tmp や . で始まるものは書きかけなので拾わない）
  work\\  拾って処理中。始めたときにここにあるものは、途中で落ちたものなので stopped: other にする（続きは入れない）
  done\\  <id>.json（処理の記録と返した答え）、<id>.request.json（届いたファイル）、<sessionId>.state.json（二重入力の鍵）
  dry\\   ドライランの記録（受け箱の状態は変えない）

ここで扱うのは invoice.request だけ。customer.query（照合）は別の部品が扱うので、拾わずに残す。
画面に送る・人に確かめる・工場に返すところは、呼ぶ側が関数で渡す（試験では偽物）。
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from inputter.plan import PlanError, load_json

from .message import Reject, check_request, envelope

MAX_FILE_BYTES = 256 * 1024


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


class Inbox:
    def __init__(self, root: Path, cfg: dict, hooks: Hooks) -> None:
        self.root = Path(root)
        self.cfg = cfg
        self.h = hooks
        self.inbox = self.root / "in"
        self.work = self.root / "work"
        self.done = self.root / "done"
        if not self.inbox.is_dir():
            raise FileNotFoundError(f"受け箱が無い: {self.inbox}")
        self.work.mkdir(exist_ok=True)
        self.done.mkdir(exist_ok=True)

    # --- 拾う ---------------------------------------------------------------

    def pending(self) -> list[Path]:
        out = []
        for p in sorted(self.inbox.iterdir(), key=lambda p: p.name):
            if p.name.startswith(".") or p.suffix != ".json" or not p.is_file():
                continue
            out.append(p)
        return out

    def _read(self, p: Path) -> object:
        if p.stat().st_size > MAX_FILE_BYTES:
            raise Reject("invalid", "ファイルが大きすぎる")
        try:
            return load_json(p)
        except (PlanError, ValueError, UnicodeDecodeError):
            raise Reject("invalid", "JSON として読めない") from None

    def _set_aside(self, p: Path, why: str) -> None:
        """id の分からないファイルは、工場に返せないので、done に脇へ寄せて残すだけ。"""
        dest = self.done / f"unreadable-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.json"
        try:
            os.replace(p, dest)
        except FileNotFoundError:
            return
        self.h.log(f"読めないファイルを脇へ寄せた（{why}）→ {dest.name}")

    # --- 状態 ---------------------------------------------------------------

    def state(self, session_id: str) -> dict | None:
        p = self.done / f"{session_id}.state.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    def _set_state(self, session_id: str, **kw) -> None:
        write_json(self.done / f"{session_id}.state.json", {**kw, "at": now_iso()})

    def record(self, request_id: str) -> dict | None:
        p = self.done / f"{request_id}.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    # --- 始めるとき -----------------------------------------------------------

    def recover(self) -> None:
        """work に残っているもの（途中で落ちた）は、続きを入れずに stopped: other にする。"""
        for p in sorted(self.work.glob("*.json")):
            try:
                msg = load_json(p)
                kind, rid, sid = envelope(msg)
            except Exception:
                self._set_aside(p, "work に残っていた読めないファイル")
                continue
            if self.record(rid) is None:
                attempt = msg.get("attempt") if isinstance(msg.get("attempt"), int) else 0
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
            if rec.get("posted") == "failed" and p.stat().st_mtime >= limit:
                rec["posted"] = self.h.post(rec["result"])
                write_json(p, rec)

    # --- 1 件の処理 -----------------------------------------------------------

    def _finish(self, work_path: Path, sid: str, rid: str, outcome: str, entered: int, reason: str | None, why: str) -> dict:
        result = result_message(sid, rid, outcome, entered, reason)
        rec = {"requestId": rid, "sessionId": sid, "why": why, "result": result, "posted": None}
        write_json(self.done / f"{rid}.json", rec)
        if work_path.exists():
            os.replace(work_path, self.done / f"{rid}.request.json")
        rec["posted"] = self.h.post(result)
        write_json(self.done / f"{rid}.json", rec)
        self.h.log(f"{rid[:8]} 作業 {sid}: {outcome}" + (f"（{reason}: {why}）" if reason else "") + f" 工場へ: {rec['posted']}")
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
        if kind != "invoice.request":
            return None  # 照合などは別の部品が拾う

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
            if not self.h.confirm(job):
                raise Abort("other", "人が入力をやめた")
            entered = self.h.enter(prepared)
        except Abort as ex:
            self._set_state(sid, status="stopped", attempt=attempt, requestId=rid)
            return self._finish(w, sid, rid, "stopped", 0, ex.reason, str(ex))
        except Exception as ex:  # 送っている途中で止まった。文は出さない（値が入り得る）
            self._set_state(sid, status="stopped", attempt=attempt, requestId=rid)
            return self._finish(w, sid, rid, "stopped", 0, "other", f"入力が途中で止まった（{type(ex).__name__}）。画面は人が確かめて閉じる")
        self._set_state(sid, status="entered", attempt=attempt, requestId=rid)
        return self._finish(w, sid, rid, "entered", entered, None, "保存の手前まで入れた。保存は人が押す")

    def run_once(self) -> int:
        n = 0
        for p in self.pending():
            if self.handle(p) is not None:
                n += 1
        return n
