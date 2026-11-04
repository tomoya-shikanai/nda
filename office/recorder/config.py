"""設定。office/recorder/config.json があれば上書きする（無くても動く）。"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, fields
from pathlib import Path


def _default_root() -> str:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return str(Path(base) / "nda-recorder")


@dataclass
class Config:
    # 対象のソフトの実行ファイル名（小文字で部分一致）。明日 `python -m recorder list` で確かめて直す。
    target_exe: list[str] = field(default_factory=lambda: ["racros"])
    # 実行ファイル名で見つからないときに使う、窓の題名（部分一致）
    target_title: list[str] = field(default_factory=lambda: ["RacroS", "ラクロス"])
    root: str = field(default_factory=_default_root)
    keep_days: int = 7
    poll_sec: float = 0.3
    min_shot_interval: float = 2.0
    jpeg_quality: int = 70
    show_indicator: bool = True


def load(path: Path | None = None) -> Config:
    path = path or Path(__file__).with_name("config.json")
    c = Config()
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        names = {f.name for f in fields(Config)}
        for k, v in data.items():
            if k in names:
                setattr(c, k, v)
    return c
