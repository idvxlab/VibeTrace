from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .evidence import Evidence, build_pair, build_single
from .skillpool import (
    Skill,
    SkillPool,
    new_id,
    one_line,
    skill_slug,
)
from .trace import Action, Cost, Message, Trace


@dataclass
class DiskSkillMeta:
    """Maps in-memory skill ids to on-disk directories."""

    id_to_path: dict[str, Path] = field(default_factory=dict)
    path_to_id: dict[str, str] = field(default_factory=dict)


def _record(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _list(v: Any) -> list[Any]:
    return v if isinstance(v, list) else []


def _primary_turn(bundle: dict[str, Any]) -> dict[str, Any]:
    schema = str(bundle.get("schemaVersion") or "")
    if schema == "trace.session.v1":
        current = bundle.get("current_turn")
        return current if isinstance(current, dict) else {}
    if schema == "trace.v1":
        return bundle
    current = bundle.get("current_turn")
    if isinstance(current, dict):
        return current
    return bundle


def _turn_actions(turn: dict[str, Any]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for subtask in _list(turn.get("subtasks")):
        if not isinstance(subtask, dict):
            continue
        for action in _list(subtask.get("actions")):
            if isinstance(action, dict):
                actions.append(action)
    return actions


def _action_from_online(raw: dict[str, Any], index: int) -> Action:
    tool = str(raw.get("tool") or raw.get("type") or "unknown")
    inp = raw.get("input")
    if not isinstance(inp, dict):
        inp = {"value": inp} if inp is not None else {}
    output = raw.get("output")
    if output is None:
        output = raw.get("error") or ""
    if not isinstance(output, str):
        output = json.dumps(output, ensure_ascii=False)
    status = str(raw.get("status") or "completed")
    if raw.get("error") and status in {"completed", "success", ""}:
        status = "error"
    duration = int(raw.get("durationMs") or 0)
    return Action(
        index=index,
        tool=tool,
        input=inp,
        output=output,
        status=status,
        start_ms=0,
        end_ms=max(0, duration),
    )


def _cost_from_turn(turn: dict[str, Any]) -> Cost:
    tokens = _record(turn.get("tokens") if isinstance(turn.get("tokens"), dict) else None)
    metrics_tokens = {}
    for subtask in _list(turn.get("subtasks")):
        if not isinstance(subtask, dict):
            continue
        metrics = _record(subtask.get("metrics"))
        breakdown = metrics.get("tokenBreakdown")
        if isinstance(breakdown, dict):
            metrics_tokens = breakdown
            break
    src = tokens or metrics_tokens
    duration_ms = float(turn.get("durationMs") or 0)
    tool_calls = 0
    for subtask in _list(turn.get("subtasks")):
        if isinstance(subtask, dict):
            tool_calls += len(_list(subtask.get("actions")))
    return Cost(
        tokens=int(src.get("total") or 0),
        time_sec=max(0.0, duration_ms / 1000.0),
        tool_calls=tool_calls,
        input_tokens=int(src.get("input") or 0),
        output_tokens=int(src.get("output") or 0),
        reasoning_tokens=int(src.get("reasoning") or 0),
        cache_read_tokens=int(src.get("cacheRead") or 0),
        cache_write_tokens=int(src.get("cacheWrite") or 0),
        dollars=float(turn.get("cost") or 0.0),
    )


def turn_to_trace(
    turn: dict[str, Any],
    *,
    instance_id: str,
    session_id: str = "",
    workspace: str = "",
    role: str = "primary",
) -> Trace:
    turn_meta = _record(turn.get("turn")) if isinstance(turn.get("turn"), dict) else turn
    user_input = str(
        turn_meta.get("userInput") or turn.get("userInput") or ""
    ).strip()
    finish = str(turn_meta.get("finish") or turn.get("finish") or "stop").strip().lower()
    actions_raw = _turn_actions(turn)
    actions = [_action_from_online(a, i + 1) for i, a in enumerate(actions_raw)]
    has_error = finish == "error" or any(a.is_error for a in actions)
    cost_src = turn_meta if turn_meta.get("tokens") or turn_meta.get("durationMs") else turn
    # Prefer nested turn block for metrics when present.
    if isinstance(turn.get("turn"), dict):
        cost = _cost_from_turn({**turn, **turn["turn"], "subtasks": turn.get("subtasks")})
    else:
        cost = _cost_from_turn(turn)

    messages: list[Message] = []
    if user_input:
        messages.append(Message(role="user", text=user_input))

    return Trace(
        instance_id=instance_id,
        session_id=session_id,
        actions=actions,
        messages=messages,
        final_text="",
        cost=cost,
        resolved=not has_error,
        error="run_error" if finish == "error" else None,
        feedback={
            "workspace": workspace,
            "fork_role": role,
            "user_input": user_input,
            "finish": finish,
        },
    )


def online_trace_to_evidence(bundle: dict[str, Any]) -> Evidence:
    """Convert memory_worker `trace.session.v1` / `trace.v1` into distiller Evidence."""
    session = _record(bundle.get("session"))
    session_id = str(session.get("id") or "").strip()
    workspace = str(session.get("directory") or "").strip()
    primary_turn = _primary_turn(bundle)
    instance_id = session_id or "online-session"
    end_id = str(
        _record(primary_turn.get("turn")).get("endAssistantMessageId")
        or primary_turn.get("endAssistantMessageId")
        or ""
    ).strip()
    if end_id:
        instance_id = f"{session_id or 'session'}:{end_id}"

    primary = turn_to_trace(
        primary_turn,
        instance_id=instance_id,
        session_id=session_id,
        workspace=workspace,
        role="primary",
    )
    problem = str(primary.feedback.get("user_input") or "").strip()
    # Include history user prompts as weak problem context when current is thin.
    history_bits: list[str] = []
    for hist in _list(bundle.get("history")):
        if not isinstance(hist, dict):
            continue
        ui = str(_record(hist.get("turn")).get("userInput") or hist.get("userInput") or "").strip()
        if ui:
            history_bits.append(ui)
    if history_bits and problem:
        problem_statement = problem
        if len(problem) < 80 and history_bits:
            problem_statement = "\n\n".join([*history_bits[-2:], problem])
    elif history_bits:
        problem_statement = "\n\n".join(history_bits[-3:])
    else:
        problem_statement = problem or "(no user prompt captured)"

    instance = {
        "instance_id": instance_id,
        "problem_statement": problem_statement,
        "session_id": session_id,
        "workspace": workspace,
    }

    fork = _record(bundle.get("fork"))
    source_turns = [x for x in _list(fork.get("sourceTurns")) if isinstance(x, dict)]
    if source_turns:
        negative = turn_to_trace(
            source_turns[-1],
            instance_id=f"{instance_id}:negative",
            session_id=str(_record(fork.get("session")).get("id") or session_id),
            workspace=workspace,
            role="negative",
        )
        positive = turn_to_trace(
            primary_turn,
            instance_id=f"{instance_id}:positive",
            session_id=session_id,
            workspace=workspace,
            role="positive",
        )
        return build_pair(instance, negative, positive)

    return build_single(instance, primary)


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)


def _parse_skill_md(content: str, default_name: str) -> tuple[str, str, str]:
    name = default_name
    description = ""
    body = content
    m = _FRONTMATTER_RE.match(content)
    if m:
        fm = m.group(1)
        body = content[m.end() :]
        for line in fm.splitlines():
            if ":" not in line:
                continue
            key, val = line.split(":", 1)
            key = key.strip().lower()
            val = val.strip().strip('"').strip("'")
            if key == "name" and val:
                name = val
            elif key == "description" and val:
                try:
                    description = json.loads(val) if val.startswith('"') else val
                except Exception:
                    description = val
    return skill_slug(name), one_line(str(description)), body.strip()


def load_pool_from_roots(roots: list[Path]) -> tuple[SkillPool, DiskSkillMeta]:
    pool = SkillPool()
    meta = DiskSkillMeta()
    seen_dirs: set[str] = set()
    for root in roots:
        if not root.exists() or not root.is_dir():
            continue
        for child in sorted(root.iterdir()):
            if not child.is_dir():
                continue
            skill_md = child / "SKILL.md"
            if not skill_md.exists():
                continue
            try:
                resolved = str(child.resolve())
            except Exception:
                resolved = str(child)
            if resolved in seen_dirs:
                continue
            seen_dirs.add(resolved)
            try:
                raw = skill_md.read_text(encoding="utf-8")
            except Exception:
                continue
            name, description, body = _parse_skill_md(raw, child.name)
            sid = new_id(name)
            # Prefer stable-ish id from folder name when it already looks like an id.
            if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", child.name) and len(child.name) <= 64:
                # Keep unique: if collision, fall back to generated id.
                if child.name not in pool.skills:
                    sid = child.name
            sk = Skill(
                id=sid,
                name=name,
                content=body or raw,
                description=description,
                kind="capability",
            )
            pool.skills[sid] = sk
            path = Path(resolved)
            meta.id_to_path[sid] = path
            meta.path_to_id[resolved.lower()] = sid
    return pool, meta


def render_skill_file(sk: Skill) -> str:
    name = skill_slug(sk.name or sk.id)
    desc = one_line(sk.description) or f"Use this skill when the task involves '{sk.name}'."
    body = sk.content.strip() or f"# {sk.name}\n\n(no content)"
    yaml_desc = json.dumps(desc, ensure_ascii=False)
    return f"---\nname: {name}\ndescription: {yaml_desc}\n---\n\n{body}\n"


@dataclass
class AppliedDiskChange:
    op: str
    skill_id: str
    skill_name: str
    skill_path: str
    frontend_operation: str
    rationale: str = ""
    removed_paths: list[str] = field(default_factory=list)


def apply_pool_to_disk(
    pool_before: SkillPool,
    pool_after: SkillPool,
    meta: DiskSkillMeta,
    *,
    write_root: Path,
    applied_msgs: list[str],
    accepted_ops: list[Any],
) -> list[AppliedDiskChange]:
    """Persist pool diffs to SKILL.md folders under write_root."""
    write_root.mkdir(parents=True, exist_ok=True)
    changes: list[AppliedDiskChange] = []
    before_ids = set(pool_before.skills)
    after_ids = set(pool_after.skills)

    # removals / merges that dropped ids
    for sid in sorted(before_ids - after_ids):
        path = meta.id_to_path.get(sid)
        sk = pool_before.skills.get(sid)
        name = sk.name if sk else sid
        removed_paths: list[str] = []
        if path and path.exists():
            try:
                shutil.rmtree(path)
                removed_paths.append(str(path))
            except Exception:
                pass
            meta.id_to_path.pop(sid, None)
            meta.path_to_id.pop(str(path).lower(), None)
        changes.append(
            AppliedDiskChange(
                op="remove",
                skill_id=sid,
                skill_name=name,
                skill_path=str(path) if path else "",
                frontend_operation="DELETE",
                rationale=f"Removed skill {name}",
                removed_paths=removed_paths,
            )
        )

    # creates / revises / merges (new or updated ids)
    for sid in sorted(after_ids):
        sk = pool_after.skills[sid]
        if sid not in before_ids:
            # create or merge result
            slug = skill_slug(sk.name or sid)
            target = write_root / slug
            if target.exists():
                # avoid clobbering unrelated folder
                target = write_root / skill_slug(f"{slug}-{sid[-6:]}")
            target.mkdir(parents=True, exist_ok=True)
            (target / "SKILL.md").write_text(render_skill_file(sk), encoding="utf-8")
            meta.id_to_path[sid] = target.resolve()
            meta.path_to_id[str(target.resolve()).lower()] = sid
            # Heuristic: merge if applied message mentions merge
            is_merge = any("merge" in str(m).lower() and sid in str(m) for m in applied_msgs)
            op_name = "merge" if is_merge else "create"
            for op in accepted_ops:
                if getattr(op, "op", "") == "merge" and getattr(op, "name", "") == sk.name:
                    op_name = "merge"
                    break
                if getattr(op, "op", "") == "create" and getattr(op, "name", "") == sk.name:
                    op_name = "create"
                    break
            changes.append(
                AppliedDiskChange(
                    op=op_name,
                    skill_id=sid,
                    skill_name=sk.name,
                    skill_path=str(target.resolve()),
                    frontend_operation="CREATE",
                    rationale=f"{'Merged' if op_name == 'merge' else 'Created'} skill {sk.name}",
                )
            )
        else:
            before = pool_before.skills[sid]
            if (
                before.content == sk.content
                and before.description == sk.description
                and before.name == sk.name
            ):
                continue
            path = meta.id_to_path.get(sid)
            if path is None:
                path = write_root / skill_slug(sk.name or sid)
                path.mkdir(parents=True, exist_ok=True)
                meta.id_to_path[sid] = path.resolve()
                meta.path_to_id[str(path.resolve()).lower()] = sid
            # rename folder if name changed and path is under write_root
            desired = write_root / skill_slug(sk.name or sid)
            if path.name != desired.name and path.parent == write_root:
                try:
                    if not desired.exists():
                        path.rename(desired)
                        path = desired
                        meta.id_to_path[sid] = path.resolve()
                        meta.path_to_id[str(path.resolve()).lower()] = sid
                except Exception:
                    pass
            (path / "SKILL.md").write_text(render_skill_file(sk), encoding="utf-8")
            changes.append(
                AppliedDiskChange(
                    op="revise",
                    skill_id=sid,
                    skill_name=sk.name,
                    skill_path=str(path.resolve()),
                    frontend_operation="UPDATE",
                    rationale=f"Revised skill {sk.name}",
                )
            )
    return changes
