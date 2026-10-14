from __future__ import annotations

DISTILL_SETTINGS = ("trace-only", "trace-fb")
SETTINGS = ("base",) + DISTILL_SETTINGS


def normalize_settings(raw=None) -> tuple[str, ...]:
    if raw is None:
        return SETTINGS
    if isinstance(raw, str):
        raw = [raw]
    selected = tuple(dict.fromkeys(raw))
    invalid = [setting for setting in selected if setting not in SETTINGS]
    if invalid or not selected:
        raise ValueError(f"invalid settings {invalid or selected}; choose from {SETTINGS}")
    return selected
