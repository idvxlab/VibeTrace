from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .evidence import Evidence
from .skillpool import SkillPool
from .trace import Action, Trace


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def token_estimate(*chunks: Any) -> int:
    total = 0
    for chunk in chunks:
        if chunk is None:
            continue
        total += len(str(chunk))
    return max(0, round(total / 4))


def action_type(tool: str) -> str:
    name = (tool or "").strip().lower().replace("-", "_")
    if "todo" in name:
        return "Plan"
    if "read" in name:
        return "Read"
    if "write" in name or "edit" in name or "patch" in name:
        return "Write"
    if "grep" in name or "search" in name or "find" in name:
        return "Search"
    if "skill" in name:
        return "Skill"
    if "bash" in name or "shell" in name or "exec" in name:
        return "Shell"
    if "task" in name or "agent" in name:
        return "Subagent"
    return "Shell"


def action_to_online(action: Action) -> dict[str, Any]:
    duration = max(0, int(action.end_ms or 0) - int(action.start_ms or 0))
    output = action.output
    return {
        "index": action.index - 1,
        "type": action_type(action.tool),
        "status": "error" if action.is_error else "completed",
        "durationMs": duration,
        "tokenEstimate": token_estimate(action.input, output),
        "input": action.input,
        "output": output,
        "error": output if action.is_error else None,
        "tool": action.tool,
    }


def turn_user_input(trace: Trace, instance: dict, role: str) -> str:
    problem = str(instance.get("problem_statement") or "")
    fork_prompt = str(trace.feedback.get("fork_prompt") or "").strip()
    if role == "positive" and fork_prompt:
        return (
            f"{problem}\n\n"
            "<simulated_user_feedback_turn>\n"
            f"{fork_prompt}\n"
            "</simulated_user_feedback_turn>"
        )
    return problem


def trace_to_turn_trace(
    trace: Trace,
    instance: dict,
    *,
    role: str = "primary",
) -> dict[str, Any]:
    actions = [action_to_online(a) for a in trace.actions]
    tokens = {
        "total": trace.c_task_tokens,
        "input": trace.cost.input_tokens,
        "output": trace.cost.output_tokens,
        "reasoning": trace.cost.reasoning_tokens,
        "cacheRead": trace.cost.cache_read_tokens,
        "cacheWrite": trace.cost.cache_write_tokens,
    }
    workspace = str(trace.feedback.get("workspace") or "")
    session_id = trace.session_id or f"{trace.instance_id}:{role}"
    generated = now_iso()
    duration_ms = round(trace.c_time * 1000)
    turn = {
        "userInput": turn_user_input(trace, instance, role),
        "startUserMessageId": f"{trace.instance_id}:{role}:user",
        "endAssistantMessageId": f"{trace.instance_id}:{role}:assistant",
        "startIndex": 0,
        "endIndex": max(0, len(actions) - 1),
        "finish": "error" if trace.error else "stop",
        "durationMs": duration_ms,
        "tokens": tokens,
        "cost": trace.cost.dollars,
    }
    return {
        "schemaVersion": "trace.v1",
        "generatedAt": generated,
        "session": {
            "id": session_id,
            "title": trace.instance_id,
            **({"directory": workspace} if workspace else {}),
        },
        "turn": turn,
        "subtasks": [
            {
                "index": 0,
                "subtaskId": f"{trace.instance_id}:{role}:main",
                "title": "Task attempt",
                "phase": "execution",
                "todos": [],
                "metrics": {
                    "durationMs": duration_ms,
                    "tokensTotal": trace.c_task_tokens,
                    "tokenBreakdown": tokens,
                    "llmCallCount": 0,
                    "cost": trace.cost.dollars,
                },
                "actions": actions,
            }
        ],
    }


def evidence_to_online_trace(e: Evidence) -> dict[str, Any]:
    current = trace_to_turn_trace(
        e.primary,
        e.instance,
        role="positive" if e.kind == "pair" else "primary",
    )
    bundle: dict[str, Any] = {
        "schemaVersion": "trace.session.v1",
        "generatedAt": now_iso(),
        "session": current.get("session") or {},
        "current_turn": current,
        "history": [],
        "ingest": {
            "turnLimit": 1,
            "primaryEndAssistantMessageId": str(
                (current.get("turn") or {}).get("endAssistantMessageId") or ""
            ),
        },
    }
    if e.kind == "pair" and e.negative is not None:
        negative = trace_to_turn_trace(
            e.negative,
            e.instance,
            role="negative",
        )
        bundle["fork"] = {
            "meta": {
                "forkAnchorMessageId": str(
                    (negative.get("turn") or {}).get("endAssistantMessageId") or ""
                ),
                "sourceParentSessionId": str(
                    ((negative.get("session") or {}).get("id") or "")
                ),
                "forkedSessionId": str(
                    ((current.get("session") or {}).get("id") or "")
                ),
            },
            "session": negative.get("session") or {},
            "sourceTurns": [negative],
        }
    return bundle


def pool_summary(pool: SkillPool) -> dict[str, Any]:
    return {
        "generatedAt": now_iso(),
        "roots": ["skillpool://memory"],
        "skills": [
            {
                "skill_name": sk.name,
                "description": sk.description,
                "source_skill_absolute_path": f"skillpool://{sid}",
                "skill_md_path": str(
                    Path(".opencode") / "skills" / sk.name / "SKILL.md"
                ),
            }
            for sid, sk in pool.skills.items()
        ],
    }
