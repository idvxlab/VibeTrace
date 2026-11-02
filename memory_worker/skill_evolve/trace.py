from __future__ import annotations

import dataclasses
import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Action:
    index: int
    tool: str
    input: dict[str, Any]
    output: str
    status: str
    start_ms: int = 0
    end_ms: int = 0

    @property
    def is_error(self) -> bool:
        return self.status not in ("completed", "success")


@dataclass
class Cost:
    tokens: int = 0
    time_sec: float = 0.0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    peak_input_tokens: int = 0
    dollars: float = 0.0


@dataclass
class Message:
    role: str
    text: str


@dataclass
class Trace:
    instance_id: str

    difficulty: str = ""
    session_id: str = ""
    actions: list[Action] = field(default_factory=list)
    messages: list[Message] = field(default_factory=list)
    final_text: str = ""
    diff: str = ""
    cost: Cost = field(default_factory=Cost)

    resolved: bool | None = None

    feedback: dict[str, Any] = field(default_factory=dict)

    raw_events: list[dict] = field(default_factory=list)
    error: str | None = None

    @property
    def c_in_tok_cached(self) -> int:
        explicit = (
            self.cost.input_tokens
            + self.cost.cache_read_tokens
            + self.cost.cache_write_tokens
        )
        if explicit > 0:
            return explicit
        out = self.c_out_tok
        if self.cost.tokens > 0:
            return max(0, self.cost.tokens - out)
        return 0

    @property
    def c_out_tok(self) -> int:
        return self.cost.output_tokens + self.cost.reasoning_tokens

    @property
    def c_task_tokens(self) -> int:
        return self.c_in_tok_cached + self.c_out_tok

    @property
    def c_time(self) -> float:
        return self.cost.time_sec

    @property
    def c_call(self) -> int:
        return self.cost.tool_calls

    @property
    def n_actions(self) -> int:
        return len(self.actions)

    @property
    def failed_run(self) -> bool:
        return self.error is not None

    def add_message(self, role: str, text: str) -> None:
        self.messages.append(Message(role=role, text=text))

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Trace":
        """Restore a persisted slim trace for checkpoint resume."""
        action_keys = {f.name for f in dataclasses.fields(Action)}
        message_keys = {f.name for f in dataclasses.fields(Message)}
        cost_keys = {f.name for f in dataclasses.fields(Cost)}
        trace_keys = {f.name for f in dataclasses.fields(cls)}
        payload = {k: v for k, v in data.items() if k in trace_keys}
        payload["actions"] = [
            Action(**{k: v for k, v in item.items() if k in action_keys})
            for item in (data.get("actions") or [])
            if isinstance(item, dict)
        ]
        payload["messages"] = [
            Message(**{k: v for k, v in item.items() if k in message_keys})
            for item in (data.get("messages") or [])
            if isinstance(item, dict)
        ]
        raw_cost = data.get("cost") or {}
        payload["cost"] = Cost(
            **{k: v for k, v in raw_cost.items() if k in cost_keys}
        )
        return cls(**payload)

    def slim(self, **extra) -> dict:
        return {**self.to_dict(), "raw_events": [], **extra}


def skill_names(trace: Trace) -> list[str]:
    """Return distinct skill names in first-use order from actual tool calls."""
    names: list[str] = []
    for action in trace.actions:
        if action.tool.lower() != "skill":
            continue
        name = action.input.get("name") if isinstance(action.input, dict) else None
        label = str(name or "(unknown)")
        if label not in names:
            names.append(label)
    return names


def skill_use_label(trace: Trace) -> str:
    return ",".join(skill_names(trace)) or "(none)"


def parse_opencode_events(
    events: list[dict],
    instance_id: str,
) -> Trace:
    trace = Trace(instance_id=instance_id, raw_events=events)
    cost = Cost()
    min_ts: int | None = None
    max_ts: int | None = None
    final_texts: list[str] = []
    action_idx = 0

    def token_value(tok: dict, *keys: str) -> int:
        for key in keys:
            val = tok.get(key)
            if val is not None:
                try:
                    return int(val or 0)
                except Exception:
                    return 0
        return 0

    for ev in events:
        ts = ev.get("timestamp")
        if isinstance(ts, int):
            min_ts = ts if min_ts is None else min(min_ts, ts)
            max_ts = ts if max_ts is None else max(max_ts, ts)
        if not trace.session_id:
            trace.session_id = ev.get("sessionID", "") or ev.get("session_id", "")

        etype = ev.get("type")
        part = ev.get("part", {}) or {}

        if etype == "tool_use":
            state = part.get("state", {}) or {}
            tm = state.get("time", {}) or {}
            output = state.get("output", "")
            if not isinstance(output, str):
                output = json.dumps(output, ensure_ascii=False)
            action_idx += 1
            trace.actions.append(
                Action(
                    index=action_idx,
                    tool=part.get("tool", "unknown"),
                    input=state.get("input", {}) or {},
                    output=output,
                    status=state.get("status", "unknown"),
                    start_ms=int(tm.get("start", 0) or 0),
                    end_ms=int(tm.get("end", 0) or 0),
                )
            )
            cost.tool_calls += 1

        elif etype == "step_finish":
            tok = part.get("tokens", {}) or {}
            step_input = int(tok.get("input", 0) or 0)
            raw_cache = tok.get("cache", {}) or {}
            cache = raw_cache if isinstance(raw_cache, dict) else {}
            cost.tokens += int(tok.get("total", 0) or 0)
            cost.input_tokens += step_input
            cost.output_tokens += int(tok.get("output", 0) or 0)
            cost.reasoning_tokens += int(tok.get("reasoning", 0) or 0)
            cost.cache_read_tokens += token_value(
                tok,
                "cacheRead",
                "cache_read",
                "cache_read_tokens",
                "input_cache_read",
                "cachedInput",
                "cached_input",
            )
            cost.cache_read_tokens += token_value(
                cache, "read", "cacheRead", "cache_read", "input"
            )
            cost.cache_write_tokens += token_value(
                tok,
                "cacheWrite",
                "cache_write",
                "cache_write_tokens",
                "input_cache_write",
            )
            cost.cache_write_tokens += token_value(
                cache, "write", "cacheWrite", "cache_write"
            )
            cost.peak_input_tokens = max(cost.peak_input_tokens, step_input)
            cost.dollars += float(part.get("cost", 0) or 0)

        elif etype == "text":
            txt = part.get("text", "")
            if txt:
                final_texts.append(txt)

    if min_ts is not None and max_ts is not None:
        cost.time_sec = max(0.0, (max_ts - min_ts) / 1000.0)
    trace.final_text = "\n".join(final_texts[-3:])
    trace.cost = cost
    return trace
