from __future__ import annotations

import itertools
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

HELPER_AGENT = os.environ.get("SE_HELPER_AGENT", "oneshot")

_JSON_CLOSE_SUFFIXES = ("]}", "}]}", '"]}')

_KEY_TICK = itertools.count()


class LLMError(RuntimeError):
    pass


def apply_rotating_keys(env: dict[str, str]) -> dict[str, str]:
    tick: int | None = None
    for name, val in os.environ.items():
        if not (name.endswith("_API_KEYS") and val.strip()):
            continue
        keys = [k.strip() for k in val.split(",") if k.strip()]
        if not keys:
            continue
        if tick is None:
            tick = next(_KEY_TICK)
        env[name[:-1]] = keys[tick % len(keys)]
    return env


def _build_env(tmp: str) -> dict[str, str]:
    env = os.environ.copy()
    if os.environ.get("SE_ISOLATE_HELPER_STATE", "1") == "0":
        return env
    xdg_root = Path(tmp) / "xdg"
    for key, subdir in (
        ("XDG_DATA_HOME", "data"),
        ("XDG_STATE_HOME", "state"),
        ("XDG_CACHE_HOME", "cache"),
    ):
        path = xdg_root / subdir
        path.mkdir(parents=True, exist_ok=True)
        env[key] = str(path)
    return env


def _parse_json_line(line: str) -> dict | None:
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None


def complete(
    prompt: str,
    model: str,
    timeout_sec: int = 300,
    variant: str | None = None,
    retries: int = 2,
    agent: str | None = HELPER_AGENT,
) -> str:
    last_err = "unknown"
    for _ in range(retries + 1):
        with tempfile.TemporaryDirectory(prefix="se_llm_") as tmp:
            cmd = ["opencode", "run", "--format", "json", "-m", model, "--dir", tmp]
            if agent:
                cmd += ["--agent", agent]
            if variant:
                cmd += ["--variant", variant]
            cmd.append(prompt)

            try:
                proc = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=timeout_sec,
                    cwd=tmp,
                    env=apply_rotating_keys(_build_env(tmp)),
                )
            except subprocess.TimeoutExpired:
                last_err = f"timeout after {timeout_sec}s"
                continue

            texts = []
            for raw in proc.stdout.splitlines():
                raw = raw.strip()
                if not raw:
                    continue
                ev = _parse_json_line(raw)
                if ev and ev.get("type") == "text":
                    txt = (ev.get("part") or {}).get("text", "")
                    if txt:
                        texts.append(txt)
            if texts:
                return "\n".join(texts)
            last_err = f"rc={proc.returncode}, stderr={proc.stderr[:200]}, stdout={proc.stdout[:200]}"

    raise LLMError(
        f"no text output from LLM (after {retries} retries). Last error: {last_err}"
    )


def complete_json(
    prompt: str,
    model: str,
    timeout_sec: int = 300,
    variant: str | None = None,
    retries: int = 2,
    validate: Callable[[dict | list], None] | None = None,
) -> dict | list:
    base = (
        prompt
        + "\n\nOutput strictly a single JSON value only (no explanation, no markdown code fences)."
    )
    last_err = LLMError("no attempts made")
    for attempt in range(retries + 1):
        instruction = (
            base
            if attempt == 0
            else (
                base + f"\n\nPrevious attempt {attempt} failed: {last_err}."
                " Return one complete, valid JSON value that matches the requested schema exactly"
                " (all brackets/braces/quotes must be closed)."
            )
        )
        raw = complete(instruction, model, timeout_sec, variant)
        try:
            data = extract_json(raw)
            if validate is not None:
                validate(data)
            return data
        except LLMError as exc:
            last_err = exc
    raise last_err


def extract_json(text: str) -> dict | list:
    fence = re.search(r"```[a-zA-Z0-9_+\-]*\s*\n(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    text = text.strip()

    try:
        return json.loads(text, strict=False)
    except json.JSONDecodeError:
        pass

    for opener, closer in (("{", "}"), ("[", "]")):
        i, j = text.find(opener), text.rfind(closer)
        if i != -1 and j > i:
            try:
                return json.loads(text[i : j + 1], strict=False)
            except json.JSONDecodeError:
                pass

    for suffix in _JSON_CLOSE_SUFFIXES:
        try:
            return json.loads(text + suffix, strict=False)
        except json.JSONDecodeError:
            pass

    raise LLMError(f"could not parse JSON from LLM output: {text[:800]}")
