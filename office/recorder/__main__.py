"""使い方（Windows、office フォルダで）:
  python -m recorder list   … 窓を持つプロセスを一覧にする（対象の実行ファイル名を確かめる）
  python -m recorder dump   … 対象のソフトの部品ツリーとスクリーンショットを書き出す（読むだけ）
  python -m recorder run    … 常駐し、対象のソフトが起動している間だけ記録する（既定）
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

from .config import load
from .core import Store, Tracker, cleanup


def run() -> None:
    from . import win

    cfg = load()
    win.set_dpi_aware()
    root = Path(cfg.root)
    cleanup(root, cfg.keep_days)
    reader = win.Reader(cfg)
    tracker = Tracker()
    store = Store(root, min_shot_interval=cfg.min_shot_interval)
    indicator = None
    if cfg.show_indicator:
        from .indicator import Indicator

        indicator = Indicator()

    last_cleanup = time.time()

    def tick() -> None:
        nonlocal last_cleanup
        try:
            s = reader.snapshot()
            for e in tracker.observe(s):
                store.write(e)
                if e.screenshot and tracker.window is not None:
                    p = store.screenshot_path(e.screenshot)
                    if p is not None and reader.screenshot(tracker.window.rect, p):
                        store.write(type(e)("screenshot", {"file": p.name, "for": e.kind}))
            if indicator is not None:
                indicator.show(s.target_pid is not None)
            if time.time() - last_cleanup > 3600:
                cleanup(root, cfg.keep_days)
                last_cleanup = time.time()
        except Exception as ex:  # 記録の失敗で常駐を止めない
            store.write(type_error(ex))

    try:
        if indicator is not None:
            indicator.loop(tick, int(cfg.poll_sec * 1000))
        else:
            while True:
                tick()
                time.sleep(cfg.poll_sec)
    except KeyboardInterrupt:
        pass
    finally:
        for e in tracker.flush():
            store.write(e)
        reader.stop()


def type_error(ex: Exception):
    from .core import Event

    return Event("error", {"error": f"{type(ex).__name__}: {ex}"[:500]})


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "run"
    if cmd == "run":
        run()
        return 0
    from . import win

    win.set_dpi_aware()
    cfg = load()
    if cmd == "list":
        print(win.list_targets())
        return 0
    if cmd == "dump":
        path = win.dump_tree(cfg, Path(cfg.root) / "dumps")
        print(path or "対象のソフトが見つからない。config.json の target_exe を `list` の結果に合わせる")
        return 0 if path else 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
