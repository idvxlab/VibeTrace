from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG_PATH = ROOT / "config" / "default.yaml"


class Config:
    def __init__(self, data: dict[str, Any]):
        self._data = data

    @classmethod
    def load(cls, path: str | os.PathLike | None = None) -> "Config":
        with open(DEFAULT_CONFIG_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        if path is not None:
            with open(path, "r", encoding="utf-8") as f:
                override = yaml.safe_load(f) or {}
            data = deep_merge(data, override)
        return cls(data)

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

    def models(self) -> list[str]:
        m = self.get("opencode.model")
        if m is None:
            return []
        if isinstance(m, str):
            return [m]
        return list(m)

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

    def resolve(self, dotted_path: str, default: Any = None) -> Path:
        val = self.get(dotted_path, default)
        if val is None:
            raise KeyError(dotted_path)
        p = Path(val)
        return p if p.is_absolute() else ROOT / p


def deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out
