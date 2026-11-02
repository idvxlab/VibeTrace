from __future__ import annotations

from collections import Counter

from .evidence import Evidence
from .prompt_format import (
    MAX_ACTION_INPUT_CHARS,
    MAX_ACTION_OUTPUT_CHARS,
    MAX_ACTIONS,
    MAX_DIFF_CHARS,
    MAX_PROBLEM_CHARS,
)
from .skillpool import SkillPool
from .trace import Action, Trace

_POOL_DESC_CHARS = 200


def inline_preview(text: str, limit: int, pad: str = "      ") -> str:
    return ((text or "").strip() or "(empty)")[:limit].replace("\n", "\n" + pad)


def _action_input(action: Action) -> str:
    return str(action.input).lower()


def _is_verification_action(action: Action) -> bool:
    if action.tool.lower() not in {"bash", "shell"}:
        return False
    text = _action_input(action)
    return any(
        marker in text
        for marker in (
            "pytest",
            "unittest",
            "tox",
            "runtests",
            "run_tests",
            " test",
            "test_",
            "tests/",
            "check ",
            "check_",
            "compileall",
            "ruff",
            "mypy",
            "pyright",
            "flake8",
            " lint",
        )
    )


def _is_required_action(action: Action) -> bool:
    tool = action.tool.lower()
    return (
        action.is_error
        or tool == "skill"
        or tool in {"write", "edit", "multiedit", "patch"}
        or _is_verification_action(action)
    )


def _sample_actions(trace: Trace) -> list[Action]:
    if trace.n_actions <= MAX_ACTIONS:
        return list(trace.actions)
    required = {a.index: a for a in trace.actions if _is_required_action(a)}
    edge = MAX_ACTIONS // 2
    for action in [*trace.actions[:edge], *trace.actions[-edge:]]:
        required[action.index] = action
    return [required[index] for index in sorted(required)]


def _format_action(action: Action) -> list[str]:
    status = "x" if action.is_error else "ok"
    inp = str(action.input)[:MAX_ACTION_INPUT_CHARS].replace("\n", " ")
    lines = [f"  {action.index}. [{status} {action.tool}] {inp}"]
    output = (action.output or "").strip().replace("\n", " ")
    if output:
        lines.append(f"     result: {output[:MAX_ACTION_OUTPUT_CHARS]}")
    return lines


def _skill_uses(trace: Trace) -> list[str]:
    uses = []
    for action in trace.actions:
        if action.tool.lower() != "skill":
            continue
        name = action.input.get("name") if isinstance(action.input, dict) else None
        uses.append(f"index={action.index}, name={name or '(unknown)'}")
    return uses


def trace_digest(t: Trace, label: str) -> str:
    lines = [
        f"### {label}",
        f"- outcome: {'SUCCEEDED' if t.resolved else 'FAILED'}",
    ]
    if t.error:
        lines.append(
            f"- run error: {str(t.error)[:200]} — the run crashed or "
            "timed out; do not attribute the failure to the approach alone"
        )
    lines.append(
        f"- cost: tokens={t.c_task_tokens}, "
        f"in_tok_cached={t.c_in_tok_cached}, out_tok={t.c_out_tok}, "
        f"time={t.c_time:.1f}s, tool_calls={t.c_call}"
    )
    tool_counts = Counter(action.tool for action in t.actions)
    if tool_counts:
        counts = ", ".join(
            f"{tool}={count}"
            for tool, count in sorted(
                tool_counts.items(), key=lambda item: (-item[1], item[0])
            )
        )
        error_count = sum(action.is_error for action in t.actions)
        lines.append(
            f"- action summary: total={t.n_actions}, errors={error_count}, by_tool: {counts}"
        )
        if error_count:
            lines.append(
                "- error actions (for fix-playbook distillation — pair with later recovery or user feedback):"
            )
            shown = 0
            for action in t.actions:
                if not action.is_error or shown >= 5:
                    continue
                inp = str(action.input)[:120].replace("\n", " ")
                out = (action.output or "").strip().replace("\n", " ")[:160]
                lines.append(f"  {action.index}. [{action.tool}] {inp}")
                if out:
                    lines.append(f"     error: {out}")
                shown += 1
    if skill_uses := _skill_uses(t):
        lines.append(f"- skills used: {'; '.join(skill_uses)}")

    sampled = _sample_actions(t)
    lines.append("- retained actions:")
    previous = 0
    for action in sampled:
        if action.index > previous + 1:
            lines.append(f"  ...({action.index - previous - 1} actions omitted)")
        lines.extend(_format_action(action))
        previous = action.index
    if previous < t.n_actions:
        lines.append(f"  ...({t.n_actions - previous} actions omitted)")
    if t.messages:
        lines.append("- feedback messages:")
        for m in t.messages:
            lines.append(f"  [{m.role}] {m.text[:400]}")
    if t.final_text:
        lines.append(f"- final response: {t.final_text[:400]}")

    diff = (t.diff or "").strip()
    if diff:
        suffix = "\n... (diff truncated)" if len(diff) > MAX_DIFF_CHARS else ""
        lines.append(
            f"- code change produced:\n```diff\n{diff[:MAX_DIFF_CHARS]}{suffix}\n```"
        )
    return "\n".join(lines)


def evidence_digest(e: Evidence) -> str:
    problem = (e.instance.get("problem_statement", "") or "")[:MAX_PROBLEM_CHARS]
    workspace = str(e.instance.get("workspace") or e.instance.get("repo") or "(unknown)")
    blocks = [
        "## User intent (PRIMARY — weight this most in distiller/scorer reasoning)\n"
        f"{problem or '(no user prompt captured)'}\n\n"
        f"- workspace: {workspace}\n"
        "- Treat the user request above as the main signal for whether a skill should exist "
        "and what `Use when` cues should say. Trace actions are supporting evidence only.\n"
        "- **User feedback messages** and **error→fix arcs** in the trace are strong evidence "
        "for fix-playbook skills — including fixes the user supplied."
    ]
    if e.kind != "pair":
        blocks.append(trace_digest(e.primary, "Trace tau"))
    else:
        blocks.extend(
            [
                "## Pair structure\n"
                "- tau+ is a recovery continuation forked from tau-'s session "
                "and workspace after user feedback; its action indices are local "
                "to the continuation and do not align with tau-.",
                trace_digest(e.negative, "Failed attempt tau- (before correction)"),
                trace_digest(
                    e.primary,
                    "Verifier-passing recovery tau+ (continuation after correction)",
                ),
            ]
        )
    return "\n\n".join(blocks)


def pool_digest(pool: SkillPool) -> str:
    if pool.is_empty():
        return "(the current skill pool is empty)"
    lines = []
    for sid, sk in pool.skills.items():
        lines.extend(
            [
                f"- id={sid} | skill_ref=skillpool://{sid} | name={sk.name}",
                f"    description (for routing): {inline_preview(sk.description, max(_POOL_DESC_CHARS, len(sk.description)))}",
            ]
        )
    return "\n".join(lines)


def pool_details(pool: SkillPool, skill_ids: list[str]) -> str:
    if not skill_ids:
        return "(no related current skills selected)"
    blocks = []
    for sid in skill_ids:
        skill = pool.skills.get(sid)
        if skill is None:
            continue
        blocks.extend(
            [
                f"### skillpool://{sid} | {skill.name}",
                f"Description: {skill.description}",
                f"Content:\n{skill.content}",
            ]
        )
    return "\n\n".join(blocks) or "(no related current skills selected)"
