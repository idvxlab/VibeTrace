from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parent

# Stdlib-only defaults — no PyYAML / SWE-bench dependencies.
_DEFAULT: dict[str, Any] = {
    "prompts": {"root": str(PACKAGE_ROOT / "prompts")},
    "opencode": {
        # Same free default as frontend / memory_worker MW_DEFAULT_MODEL_REF.
        "model": os.environ.get("MW_SKILL_EVOLVE_MODEL")
        or os.environ.get("MW_OPENCODE_MODEL")
        or os.environ.get("OPENCODE_MODEL")
        or "opencode/big-pickle",
        "variant": None,
        "timeout_sec": 300,
    },
    "estimator": {
        "model": None,
        "timeout_sec": 300,
        "retries": 2,
        "reusable_min": 0.34,
        "informative_min": 0.20,
        "risk_max": 0.40,
    },
    "distiller": {
        "max_skills_per_patch": 3,
        "model": None,
        "max_skill_chars": 1200,
        "reuse_gate_min": 0.50,
        "correctness_gate_min": 0.50,
        "score_threshold": 0.10,
        "score_retries": 5,
        "timeout_sec": 300,
    },
}


def deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


class Config:
    def __init__(self, data: dict[str, Any] | None = None):
        self._data = deep_merge(_DEFAULT, data or {})

    @classmethod
    def load(cls, overrides: dict[str, Any] | None = None) -> "Config":
        return cls(overrides)

    def get(self, dotted: str, default: Any = None) -> Any:
        node: Any = self._data
        for key in dotted.split("."):
            if not isinstance(node, dict) or key not in node:
                return default
            node = node[key]
        return node

    def set(self, dotted: str, value: Any) -> None:
        keys = dotted.split(".")
        node = self._data
        for key in keys[:-1]:
            nxt = node.get(key)
            if not isinstance(nxt, dict):
                nxt = {}
                node[key] = nxt
            node = nxt
        node[keys[-1]] = value

    def clone(self) -> "Config":
        return Config(copy.deepcopy(self._data))

    def llm_settings(
        self, ns: str, *, default_timeout: int = 300
    ) -> tuple[str | None, str | None, int]:
        model = self.get(f"{ns}.model") or self.get("opencode.model")
        if isinstance(model, list):
            model = model[0] if model else None
        variant = self.get(f"{ns}.variant") or self.get("opencode.variant")
        timeout = int(self.get(f"{ns}.timeout_sec", default_timeout))
        return model, variant, timeout

    @property
    def data(self) -> dict[str, Any]:
        return self._data
