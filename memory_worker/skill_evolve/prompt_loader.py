from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import Config, PACKAGE_ROOT

PROMPT_ROOT = PACKAGE_ROOT / "prompts"


def load_prompt(name: str, cfg: Config | None = None) -> str:
    root = PROMPT_ROOT
    if cfg is not None:
        raw = cfg.get("prompts.root")
        if raw:
            candidate = Path(str(raw))
            root = candidate if candidate.is_absolute() else PACKAGE_ROOT / candidate
    path = root / name
    return path.read_text(encoding="utf-8")


def render_template(template: str, values: dict[str, Any]) -> str:
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", str(value))
    return rendered
