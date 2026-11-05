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
    # 対象のソフトの実行ファイル名（完全一致、大文字小文字は区別しない）。
    # 仮の値。`python -m recorder list` で確かめて config.json で直す。
    target_exe: list[str] = field(default_factory=lambda: ["RacroS.exe"])
    root: str = field(default_factory=_default_root)
    keep_days: int = 7
    poll_sec: float = 0.3
    # UI Automation の 1 回の呼び出しを待つ上限（ミリ秒）。0 なら Windows の既定（20 秒）のまま
    uia_timeout_ms: int = 3000
    min_shot_interval: float = 2.0
    jpeg_quality: int = 70
    show_indicator: bool = True
    # 入力した値が Name に出る部品のクラス名。Name を値として扱い、記録には文字数だけを残す
    name_value_classes: list[str] = field(default_factory=lambda: ["TextEdit", "NumEdit"])


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
