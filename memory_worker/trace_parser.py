from __future__ import annotations

import json
import math
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable

TRACE_CHILD_SESSION_MAX_DEPTH = 8
DEFAULT_TRACE_SESSION_TURN_LIMIT = 5
SUBAGENT_TOOLS = {"task", "subtask", "subagent", "agent"}
TODO_WRITE_TOOL_NAMES = {"todowrite", "todo_write", "write_todos", "update_todos"}


def _record(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _list(v: Any) -> list[Any]:
    return v if isinstance(v, list) else []


def _parts(message: dict[str, Any]) -> list[dict[str, Any]]:
    return [p for p in _list(message.get("parts")) if isinstance(p, dict)]


def _info(message: dict[str, Any]) -> dict[str, Any]:
    return _record(message.get("info"))


def _now_ms() -> int:
    return int(time.time() * 1000)


def _iso_now_ms(now_ms: int) -> str:
    return datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).isoformat()


def normalize_trace_payload(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    schema = payload.get("schemaVersion")
    if schema in ("trace.v1", "trace.session.v1"):
        return payload
    trace = payload.get("trace")
    if isinstance(trace, dict) and trace.get("schemaVersion") in ("trace.v1", "trace.session.v1"):
        return trace
    return None


def normalize_epoch_ms(value: Any) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        return 0
    if value < 1e11:
        return value * 1000
    if value > 1e14:
        return math.floor(value / 1000)
    return value


def _normalize_tool_name(name: str) -> str:
    return name.strip().lower().replace("-", "_")


def is_todo_write_tool(tool_name: str) -> bool:
    t = _normalize_tool_name(tool_name)
    return t in TODO_WRITE_TOOL_NAMES or "todo_write" in t or t.endswith("_todowrite")


def _map_tool_to_action_type(tool: str) -> str | None:
    t = _normalize_tool_name(tool)
    if t == "question":
        return "Clarify"
    if is_todo_write_tool(tool) or t in {"todoread", "todo_read"}:
        return "Plan"
    if t in SUBAGENT_TOOLS:
        return "Subagent"
    if t in {"glob", "grep", "read"}:
        return "Read"
    if t in {"skill_router", "skillrouter"}:
        return "SkillRouter"
    if t in {"write", "edit", "multiedit", "patch"}:
        return "Write"
    if t in {"bash", "shell"}:
        return "Shell"
    if t in {"websearch", "web_search", "webfetch", "web_fetch"}:
        return "Search"
    if t == "skill":
        return "Skill"
    return None


def _estimate_tokens_from_strings(*chunks: Any) -> int:
    n = 0
    for c in chunks:
        if isinstance(c, str) and c:
            n += len(c)
    return max(0, round(n / 4))


def _json_string(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float, bool)):
        return str(v)
    try:
        return json.dumps(v, ensure_ascii=False)
    except Exception:
        return str(v)


_LEGACY_CN_USER_INPUT = "\u3010\u7528\u6237\u8f93\u5165\u3010"


def _strip_harness_guidance(text: str) -> str:
    if not text:
        return text
    normalized = text.replace("\r\n", "\n")
    markers = [
        "\n\n---\n用户输入\n",
        "\n---\n用户输入\n",
        "\n\n---\nUser input\n",
        "\n---\nUser input\n",
        f"\n\n---\n{_LEGACY_CN_USER_INPUT}\n",
        f"\n---\n{_LEGACY_CN_USER_INPUT}\n",
    ]
    for marker in markers:
        idx = normalized.find(marker)
        if idx >= 0:
            return normalized[idx + len(marker) :].lstrip()
    m = re.search(
        rf"\n---\s*\n(?:用户输入|User input|{re.escape(_LEGACY_CN_USER_INPUT)})\s*\n",
        normalized,
    )
    if m:
        return normalized[m.end() :].lstrip()
    return text


def _user_text(message: dict[str, Any]) -> str:
    texts = [str(p.get("text") or "") for p in _parts(message) if p.get("type") == "text"]
    raw = "\n\n".join([t for t in texts if t]) or str(_info(message).get("content") or "")
    return _strip_harness_guidance(raw).strip()


def _get_message_finish(message: dict[str, Any]) -> str | None:
    info = _info(message)
    direct = _record(message)
    nested = _record(message.get("message"))
    for x in (info.get("finish"), nested.get("finish"), direct.get("finish")):
        if isinstance(x, str) and x:
            return x
    return None


def is_assistant_stop_message(message: dict[str, Any]) -> bool:
    if _info(message).get("role") != "assistant":
        return False
    return (_get_message_finish(message) or "").strip().lower() == "stop"


def find_assistant_stop_turn_end_ids(messages: list[dict[str, Any]]) -> list[str]:
    ids: list[str] = []
    for msg in messages:
        mid = _info(msg).get("id")
        if isinstance(mid, str) and is_assistant_stop_message(msg):
            ids.append(mid)
    return ids


def collect_turn_prompt_records(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Chronological user prompts paired with assistant stop message IDs."""
    records: list[dict[str, Any]] = []
    for end_id in find_assistant_stop_turn_end_ids(messages):
        end_index = next((i for i, m in enumerate(messages) if _info(m).get("id") == end_id), -1)
        if end_index < 0:
            continue
        start_index = -1
        for i in range(end_index, -1, -1):
            if _info(messages[i]).get("role") == "user":
                start_index = i
                break
        if start_index < 0:
            continue
        user_message = messages[start_index]
        end_message = messages[end_index]
        user_info = _info(user_message)
        end_info = _info(end_message)
        user_time = _record(user_info.get("time"))
        end_time = _record(end_info.get("time"))
        records.append(
            {
                "userInput": _user_text(user_message),
                "startUserMessageId": str(user_info.get("id") or ""),
                "endAssistantMessageId": end_id,
                "startIndex": start_index,
                "endIndex": end_index,
                "created": user_time.get("created"),
                "completed": end_time.get("completed"),
            }
        )
    return records


def slice_messages_for_turn(
    messages: list[dict[str, Any]],
    end_assistant_message_id: str,
) -> list[dict[str, Any]] | None:
    end_index = next((i for i, m in enumerate(messages) if _info(m).get("id") == end_assistant_message_id), -1)
    if end_index < 0 or not is_assistant_stop_message(messages[end_index]):
        return None
    start_index = -1
    for i in range(end_index, -1, -1):
        if _info(messages[i]).get("role") == "user":
            start_index = i
            break
    if start_index < 0:
        return None
    return messages[start_index : end_index + 1]


def select_turn_end_ids_for_session_ingest(
    messages: list[dict[str, Any]],
    primary_end_assistant_message_id: str,
    max_turns: int,
) -> list[str]:
    chronological = find_assistant_stop_turn_end_ids(messages)
    try:
        primary_idx = chronological.index(primary_end_assistant_message_id)
    except ValueError:
        return []
    limit = max(1, max_turns)
    window_start = max(0, primary_idx - limit + 1)
    return list(reversed(chronological[window_start : primary_idx + 1]))


def find_turn_ends_from_anchor(
    messages: list[dict[str, Any]],
    anchor_message_id: str,
    max_subsequent_turns: int = 3,
) -> list[str]:
    anchor_idx = next((i for i, m in enumerate(messages) if _info(m).get("id") == anchor_message_id), -1)
    if anchor_idx < 0:
        return []
    out: list[str] = []
    for stop_id in find_assistant_stop_turn_end_ids(messages):
        stop_idx = next((i for i, m in enumerate(messages) if _info(m).get("id") == stop_id), -1)
        if stop_idx >= anchor_idx:
            out.append(stop_id)
            if len(out) >= 1 + max_subsequent_turns:
                break
    return out


def trace_tokens_from_messages(messages: list[dict[str, Any]]) -> dict[str, int]:
    out = {"input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
    for msg in messages:
        if _info(msg).get("role") != "assistant":
            continue
        t = _record(_info(msg).get("tokens"))
        cache = _record(t.get("cache"))
        out["input"] += int(t.get("input") or 0)
        out["output"] += int(t.get("output") or 0)
        out["reasoning"] += int(t.get("reasoning") or 0)
        out["cacheRead"] += int(cache.get("read") or 0)
        out["cacheWrite"] += int(cache.get("write") or 0)
    out["total"] = out["input"] + out["output"] + out["reasoning"] + out["cacheRead"] + out["cacheWrite"]
    return out


def _token_total_for_message(tokens: Any) -> int:
    t = _record(tokens)
    if isinstance(t.get("total"), (int, float)) and t["total"] > 0:
        return int(t["total"])
    cache = _record(t.get("cache"))
    return int(t.get("input") or 0) + int(t.get("output") or 0) + int(t.get("reasoning") or 0) + int(cache.get("read") or 0) + int(cache.get("write") or 0)


def cost_from_messages(messages: list[dict[str, Any]]) -> float:
    total = 0.0
    for msg in messages:
        cost = _info(msg).get("cost")
        if isinstance(cost, (int, float)) and math.isfinite(cost):
            total += float(cost)
    return total


def _normalize_status(raw: Any) -> str:
    s = str(raw or "").lower().replace(" ", "_")
    if s in {"completed", "complete"}:
        return "completed"
    if s in {"in_progress", "inprogress", "in-progress"}:
        return "in_progress"
    return "pending"


def _normalize_priority(raw: Any) -> str:
    s = str(raw or "medium").lower()
    if s == "high":
        return "high"
    if s == "low":
        return "low"
    return "medium"


def _normalize_todo_item(item: Any) -> dict[str, Any] | None:
    o = _record(item)
    content = o.get("content")
    if not isinstance(content, str) or not content.strip():
        return None
    out = {
        "content": content.strip(),
        "status": _normalize_status(o.get("status")),
        "priority": _normalize_priority(o.get("priority")),
    }
    tid = o.get("id")
    if isinstance(tid, str) and tid.strip():
        out["id"] = tid.strip()
    return out


def _normalize_todos(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        todo = _normalize_todo_item(item)
        if todo:
            out.append(todo)
    return out


def parse_todowrite_todos_from_tool_part(part: dict[str, Any]) -> list[dict[str, Any]] | None:
    state = _record(part.get("state"))
    input_obj = _record(state.get("input"))
    for candidate in (input_obj.get("todos"), _record(state.get("metadata")).get("todos")):
        todos = _normalize_todos(candidate)
        if todos:
            return todos
    output = state.get("output")
    if isinstance(output, str) and output.strip():
        try:
            todos = _normalize_todos(json.loads(output))
            if todos:
                return todos
        except Exception:
            pass
    return None


def parse_todowrite_todos_from_message(message: dict[str, Any]) -> list[dict[str, Any]] | None:
    if _info(message).get("role") != "assistant":
        return None
    for part in _parts(message):
        if part.get("type") == "tool" and is_todo_write_tool(str(part.get("tool") or "")):
            todos = parse_todowrite_todos_from_tool_part(part)
            if todos:
                return todos
    return None


def _todo_key(todo: dict[str, Any]) -> str:
    tid = str(todo.get("id") or "").strip()
    return f"id:{tid}" if tid else f"c:{str(todo.get('content') or '').strip()}"


def _diff_newly_completed(prev: list[dict[str, Any]] | None, nxt: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not prev:
        return []
    prev_by_key = {_todo_key(t): t for t in prev}
    out: list[dict[str, Any]] = []
    for n in nxt:
        if n.get("status") != "completed":
            continue
        p = prev_by_key.get(_todo_key(n))
        if p and p.get("status") != "completed":
            out.append(dict(n))
    return out


def _linked_todo_ids(todos: list[dict[str, Any]]) -> list[str]:
    return sorted({str(t.get("id")).strip() for t in todos if str(t.get("id") or "").strip()})


def _all_todos_completed(todos: list[dict[str, Any]]) -> bool:
    return bool(todos) and all(t.get("status") == "completed" for t in todos)


def _subtask_id(indices: list[int], messages: list[dict[str, Any]]) -> str:
    if not indices:
        return "subtask-empty"
    head = messages[indices[0]]
    mid = _info(head).get("id")
    if isinstance(mid, str) and mid:
        return f"subtask-{mid}"
    return f"subtask-idx-{indices[0]}-{indices[-1]}"


def _assistant_ranges_split_by_user(messages: list[dict[str, Any]]) -> list[dict[str, list[int]]]:
    out: list[dict[str, list[int]]] = []
    pending_users: list[int] = []
    current_assistants: list[int] = []

    def flush() -> None:
        nonlocal pending_users, current_assistants
        if not current_assistants:
            return
        out.append({"assistantIndices": current_assistants, "userMessageIndices": pending_users})
        pending_users = []
        current_assistants = []

    for i, msg in enumerate(messages):
        role = _info(msg).get("role")
        if role == "user":
            flush()
            pending_users.append(i)
        elif role == "assistant":
            current_assistants.append(i)
    flush()
    return out


def _collect_indices_inclusive(indices: list[int], lo: int, hi: int) -> list[int]:
    return [x for x in indices if lo <= x <= hi]


def group_assistant_subtasks(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    subtasks: list[dict[str, Any]] = []
    for r in _assistant_ranges_split_by_user(messages):
        range_indices = r["assistantIndices"]
        user_indices = r["userMessageIndices"]
        range_subtasks: list[dict[str, Any]] = []

        def push(indices: list[int], phase: str, todos: list[dict[str, Any]], newly: list[dict[str, Any]]) -> None:
            if not indices:
                return
            range_subtasks.append(
                {
                    "subtask_id": _subtask_id(indices, messages),
                    "phase": phase,
                    "todos": [dict(t) for t in todos],
                    "todosNewlyCompleted": [dict(t) for t in newly],
                    "linkedTodoIds": _linked_todo_ids(newly),
                    "userMessageIndices": list(user_indices) if not range_subtasks else [],
                    "assistantMessageIndices": indices,
                }
            )

        tw_indices = [idx for idx in range_indices if parse_todowrite_todos_from_message(messages[idx])]
        if not tw_indices:
            push(list(range_indices), "planning", [], [])
            subtasks.extend(range_subtasks)
            continue

        snap_at_tw: dict[int, list[dict[str, Any]]] = {}
        for idx in tw_indices:
            snap_at_tw[idx] = parse_todowrite_todos_from_message(messages[idx]) or []

        segment_start = tw_indices[0]
        first_assistant = range_indices[0]
        if segment_start > first_assistant:
            push(_collect_indices_inclusive(range_indices, first_assistant, segment_start - 1), "planning", [], [])

        for k in range(1, len(tw_indices)):
            prev_tw = tw_indices[k - 1]
            cur_tw = tw_indices[k]
            newly = _diff_newly_completed(snap_at_tw.get(prev_tw), snap_at_tw.get(cur_tw, []))
            if not newly:
                continue
            push(
                _collect_indices_inclusive(range_indices, segment_start, cur_tw),
                "execution",
                snap_at_tw.get(cur_tw, []),
                newly,
            )
            segment_start = cur_tw + 1

        trailing = _collect_indices_inclusive(range_indices, segment_start, range_indices[-1])
        if trailing:
            last_snap = snap_at_tw.get(tw_indices[-1], [])
            push(trailing, "wrap_up" if _all_todos_completed(last_snap) else "execution", last_snap, [])

        subtasks.extend(range_subtasks)
    return subtasks


def _duration_for_text(text: str) -> int:
    return max(50, 50 + len(text) * 15)


def _duration_for_reasoning(part: dict[str, Any]) -> int:
    tm = _record(part.get("time"))
    start, end = tm.get("start"), tm.get("end")
    if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end >= start:
        return max(10, int(end - start)) if end > start else 10
    return min(30000, max(0, _estimate_tokens_from_strings(part.get("text")) * 40))


def _tool_wall_clock_window(part: dict[str, Any], message: dict[str, Any], now_ms: int) -> dict[str, float] | None:
    state = _record(part.get("state"))
    tm = _record(state.get("time"))
    start = tm.get("start")
    if not isinstance(start, (int, float)) or not math.isfinite(start):
        start = _record(_info(message).get("time")).get("created")
        if not isinstance(start, (int, float)) or not math.isfinite(start):
            return None
    end = tm.get("end")
    if isinstance(end, (int, float)) and end >= start:
        return {"startMs": start, "endMs": end}
    if state.get("status") in {"running", "pending"}:
        return {"startMs": start, "endMs": now_ms}
    return {"startMs": start, "endMs": start + 1}


def _duration_for_tool(part: dict[str, Any], message: dict[str, Any], now_ms: int) -> int:
    state = _record(part.get("state"))
    tm = _record(state.get("time"))
    status = state.get("status")
    if status in {"running", "pending"}:
        start = tm.get("start") or _record(_info(message).get("time")).get("created")
        return max(0, int(now_ms - start)) if isinstance(start, (int, float)) else 0
    start, end = tm.get("start"), tm.get("end")
    if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end > start:
        return max(10, int(end - start))
    created = _record(_info(message).get("time")).get("created") or 0
    completed = _record(_info(message).get("time")).get("completed")
    if isinstance(completed, (int, float)) and completed > created:
        return max(10, int(completed - created))
    return max(10, 80 + _estimate_tokens_from_strings(_json_string(state.get("output")), _json_string(state.get("input"))) * 30)


def _extract_child_session_id(part: dict[str, Any]) -> str | None:
    state = _record(part.get("state"))
    inp = _record(state.get("input"))
    meta = _record(state.get("metadata"))
    out = state.get("output")
    out_obj: dict[str, Any] = {}
    if isinstance(out, dict):
        out_obj = out
    elif isinstance(out, str) and out.strip():
        try:
            parsed = json.loads(out)
            if isinstance(parsed, dict):
                out_obj = parsed
        except Exception:
            pass
    out_meta = _record(out_obj.get("metadata"))
    for v in (
        meta.get("sessionId"),
        meta.get("sessionID"),
        meta.get("task_id"),
        out_meta.get("sessionId"),
        out_meta.get("sessionID"),
        out_meta.get("task_id"),
        out_obj.get("sessionId"),
        out_obj.get("sessionID"),
        out_obj.get("task_id"),
        inp.get("sessionId"),
        inp.get("sessionID"),
    ):
        if isinstance(v, str) and v.strip():
            return v.strip()
    m = re.search(r"task_id:\s*([A-Za-z0-9_-]+)", _json_string(out), flags=re.I)
    return m.group(1) if m else None


def collect_task_child_descriptors(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for msg in messages:
        if _info(msg).get("role") != "assistant":
            continue
        base_time = _record(_info(msg).get("time")).get("created") or 0
        for part_index, part in enumerate(_parts(msg)):
            if part.get("type") != "tool" or _normalize_tool_name(str(part.get("tool") or "")) not in SUBAGENT_TOOLS:
                continue
            sid = _extract_child_session_id(part)
            if not sid:
                continue
            key = f"{part.get('callID')}__{sid}"
            if key in seen:
                continue
            seen.add(key)
            inp = _record(_record(part.get("state")).get("input"))
            out.append(
                {
                    "callID": str(part.get("callID") or ""),
                    "childSessionID": sid,
                    "messageId": str(_info(msg).get("id") or ""),
                    "anchorSortTime": float(base_time) + part_index * 0.001,
                    "description": inp.get("description") if isinstance(inp.get("description"), str) else None,
                }
            )
    return out


def _collect_task_descriptors_with_nested_children(
    segment_messages: list[dict[str, Any]],
    child_messages_by_session_id: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def visit(msgs: list[dict[str, Any]]) -> None:
        for d in collect_task_child_descriptors(msgs):
            key = f"{d.get('callID')}__{d.get('childSessionID')}"
            if key in seen:
                continue
            seen.add(key)
            out.append(d)
            child_msgs = child_messages_by_session_id.get(str(d.get("childSessionID") or ""))
            if child_msgs:
                visit(child_msgs)

    visit(segment_messages)
    return out


def fetch_child_messages_for_turn(
    turn_messages: list[dict[str, Any]],
    directory: str | None,
    fetch_messages: Callable[[str, str | None], list[dict[str, Any]]],
    max_depth: int = TRACE_CHILD_SESSION_MAX_DEPTH,
) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    seen: set[str] = set()
    frontier = [str(d["childSessionID"]) for d in collect_task_child_descriptors(turn_messages)]
    depth = 0
    while frontier and depth < max_depth:
        batch = [sid for sid in dict.fromkeys(frontier) if sid not in seen]
        frontier = []
        if not batch:
            break
        for sid in batch:
            seen.add(sid)
            try:
                msgs = fetch_messages(sid, directory)
                result[sid] = msgs if isinstance(msgs, list) else []
                for nested in collect_task_child_descriptors(result[sid]):
                    child = str(nested.get("childSessionID") or "")
                    if child and child not in seen:
                        frontier.append(child)
            except Exception:
                result[sid] = []
        depth += 1
    return result


def _tool_status(part: dict[str, Any], stale_call_ids: set[str]) -> str:
    state = _record(part.get("state"))
    if state.get("status") == "error":
        return "error"
    call_id = str(part.get("callID") or "")
    if call_id and call_id in stale_call_ids:
        return "error"
    if state.get("status") in {"running", "pending"}:
        return "running"
    return "completed"


def _collect_stale_tool_call_ids(messages: list[dict[str, Any]]) -> set[str]:
    stale: set[str] = set()
    assistant_indices = [i for i, m in enumerate(messages) if _info(m).get("role") == "assistant"]
    for idx in assistant_indices[:-1]:
        for p in _parts(messages[idx]):
            if p.get("type") == "tool" and _record(p.get("state")).get("status") in {"running", "pending"}:
                call_id = str(p.get("callID") or "")
                if call_id:
                    stale.add(call_id)
    return stale


def build_mapped_actions_from_messages(
    messages: list[dict[str, Any]],
    now_ms: int,
    band_start: int = 0,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    stale = _collect_stale_tool_call_ids(messages)

    def row_for(action_type: str) -> int:
        return band_start * 2 + (0 if action_type in {"UserRequest", "Think", "Response", "Compaction", "Plan"} else 1)

    for message_index, message in enumerate(messages):
        info = _info(message)
        base_time = _record(info.get("time")).get("created") or 0
        mid = str(info.get("id") or "")
        if info.get("role") == "user":
            text = _user_text(message)
            first_text_index = next((i for i, p in enumerate(_parts(message)) if p.get("type") == "text"), 0)
            first_text = _parts(message)[first_text_index] if _parts(message) else {}
            out.append(
                {
                    "actionType": "UserRequest",
                    "status": "completed",
                    "durationMs": max(10, _duration_for_text(text)),
                    "tokenEstimate": _estimate_tokens_from_strings(text),
                    "sortTime": base_time,
                    "source": "part",
                    "sessionID": info.get("sessionID"),
                    "messageID": mid,
                    "partIndex": first_text_index,
                    "messageIndex": message_index,
                    "partId": first_text.get("id"),
                    "detail": text or "(empty)",
                    "row": row_for("UserRequest"),
                }
            )
            continue
        if info.get("role") != "assistant":
            continue
        for part_index, part in enumerate(_parts(message)):
            sort_time = float(base_time) + part_index * 0.001
            typ = part.get("type")
            action: dict[str, Any] | None = None
            if typ == "reasoning":
                text = str(part.get("text") or "")
                action = {
                    "actionType": "Think",
                    "status": "completed",
                    "durationMs": _duration_for_reasoning(part),
                    "tokenEstimate": _estimate_tokens_from_strings(text),
                    "detail": text[:80],
                }
            elif typ == "text":
                text = str(part.get("text") or "")
                action = {
                    "actionType": "Response",
                    "status": "completed",
                    "durationMs": _duration_for_text(text),
                    "tokenEstimate": _estimate_tokens_from_strings(text),
                    "detail": text[:80],
                }
            elif typ == "compaction":
                action = {
                    "actionType": "Compaction",
                    "status": "completed",
                    "durationMs": 400,
                    "tokenEstimate": _estimate_tokens_from_strings(part.get("text")),
                }
            elif typ == "tool":
                tool = str(part.get("tool") or "")
                mapped = _map_tool_to_action_type(tool)
                if not mapped:
                    continue
                state = _record(part.get("state"))
                child_sid = _extract_child_session_id(part) if _normalize_tool_name(tool) in SUBAGENT_TOOLS else None
                status = _tool_status(part, stale)
                action = {
                    "actionType": mapped,
                    "status": status,
                    "durationMs": _duration_for_tool(part, message, now_ms),
                    "tokenEstimate": _estimate_tokens_from_strings(_json_string(state.get("input")), _json_string(state.get("output")), _json_string(state.get("error"))),
                    "callID": part.get("callID"),
                    "childSessionID": child_sid,
                    "parallelKey": part.get("callID") or child_sid,
                    "toolWindow": _tool_wall_clock_window(part, message, now_ms),
                    "detail": tool,
                    "errorMessage": _json_string(state.get("error")) or ("Tool did not finalize before next assistant turn." if status == "error" else None),
                }
            if not action:
                continue
            action.update(
                {
                    "sortTime": sort_time,
                    "source": "part",
                    "sessionID": info.get("sessionID"),
                    "messageID": mid,
                    "partIndex": part_index,
                    "messageIndex": message_index,
                    "partId": part.get("id"),
                    "row": row_for(action["actionType"]),
                }
            )
            out.append(action)
    return out


def _find_part_for_mapped_action(action: dict[str, Any], segment_messages: list[dict[str, Any]], child_messages_by_session_id: dict[str, list[dict[str, Any]]]) -> dict[str, Any] | None:
    mi = action.get("messageIndex")
    pi = action.get("partIndex")
    if not isinstance(mi, int) or not isinstance(pi, int):
        return None
    if action.get("source") == "child-session" and action.get("branchChildSessionID"):
        msgs = child_messages_by_session_id.get(str(action.get("branchChildSessionID")))
        return _parts(msgs[mi])[pi] if msgs and mi < len(msgs) and pi < len(_parts(msgs[mi])) else None
    return _parts(segment_messages[mi])[pi] if mi < len(segment_messages) and pi < len(_parts(segment_messages[mi])) else None


def _mapped_action_to_trace_action(action: dict[str, Any], index: int, segment_messages: list[dict[str, Any]], child_messages_by_session_id: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    part = _find_part_for_mapped_action(action, segment_messages, child_messages_by_session_id)
    payload: dict[str, Any] = {"input": None, "output": None, "error": None}
    if part and part.get("type") == "tool":
        state = _record(part.get("state"))
        payload = {"tool": part.get("tool"), "input": state.get("input"), "output": state.get("output"), "error": state.get("error")}
    elif part and part.get("type") in {"text", "reasoning"}:
        payload = {"input": None, "output": part.get("text") or "", "error": None}
    is_user = action.get("actionType") == "UserRequest"
    out = {
        "index": index,
        "type": action.get("actionType"),
        "tool": payload.get("tool"),
        "status": action.get("status"),
        "durationMs": action.get("durationMs") or 0,
        "tokenEstimate": action.get("tokenEstimate") or 0,
        "input": action.get("detail") or "" if is_user else payload.get("input"),
        "output": None if is_user else payload.get("output"),
        "error": payload.get("error") if payload.get("error") is not None else action.get("errorMessage"),
    }
    if action.get("source") == "child-session":
        out["source"] = "child-session"
        out["childSessionID"] = action.get("branchChildSessionID") or action.get("childSessionID")
        out["parentTaskCallID"] = action.get("parentTaskCallID")
    else:
        out["source"] = "parent"
    return out


def _child_messages_for_descriptors(descriptors: list[dict[str, Any]], child_messages_by_session_id: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for d in descriptors:
        sid = str(d.get("childSessionID") or "")
        if not sid or sid in seen:
            continue
        seen.add(sid)
        out.extend(child_messages_by_session_id.get(sid, []))
    return out


def _build_merged_subtask_actions(segment_messages: list[dict[str, Any]], child_messages_by_session_id: dict[str, list[dict[str, Any]]], now_ms: int) -> list[dict[str, Any]]:
    parent_actions = build_mapped_actions_from_messages(segment_messages, now_ms)
    task_descriptors = _collect_task_descriptors_with_nested_children(segment_messages, child_messages_by_session_id)
    child_actions: list[dict[str, Any]] = []
    band_by_session: dict[str, int] = {}
    next_band = 1
    for d in sorted(task_descriptors, key=lambda x: float(x.get("anchorSortTime") or 0)):
        sid = str(d.get("childSessionID") or "")
        if sid and sid not in band_by_session:
            band_by_session[sid] = next_band
            next_band += 1
        child_msgs = child_messages_by_session_id.get(sid, [])
        if not child_msgs:
            continue
        inner = build_mapped_actions_from_messages(child_msgs, now_ms, band_by_session.get(sid, 1))
        if not inner:
            continue
        min_t = min(float(a.get("sortTime") or 0) for a in inner)
        for i, action in enumerate(inner):
            copied = dict(action)
            copied["sortTime"] = float(d.get("anchorSortTime") or 0) + 0.002 + (float(action.get("sortTime") or 0) - min_t) + i * 1e-9
            copied["source"] = "child-session"
            copied["branchChildSessionID"] = sid
            copied["parentTaskCallID"] = d.get("callID")
            child_actions.append(copied)
    merged = sorted([*parent_actions, *child_actions], key=lambda a: float(a.get("sortTime") or 0))
    return [_mapped_action_to_trace_action(action, i, segment_messages, child_messages_by_session_id) for i, action in enumerate(merged)]


def _derive_subtask_title(st: dict[str, Any], messages: list[dict[str, Any]], display_index: int) -> str:
    if st.get("phase") == "planning":
        return "Research & plan"
    if st.get("phase") == "wrap_up":
        return "Wrap-up & output"
    newly = _list(st.get("todosNewlyCompleted"))
    if newly:
        content = str(_record(newly[0]).get("content") or "")
        # Keep a generous first-todo snippet; the card UI truncates/expands for display.
        head = content[:120].rstrip() + "…" if len(content) > 120 else content
        more = f" +{len(newly) - 1} more" if len(newly) > 1 else ""
        return f"Done: {head}{more}"
    for idx in _list(st.get("assistantMessageIndices")):
        if isinstance(idx, int) and idx < len(messages):
            for part in _parts(messages[idx]):
                if part.get("type") == "text" and str(part.get("text") or "").strip():
                    # Prefer the full first line (capped) so expand-to-wrap can show the real title.
                    line = str(part["text"]).strip().split("\n")[0]
                    if len(line) > 200:
                        return line[:200].rstrip() + "…"
                    return line
    return f"Subtask {display_index + 1}"


def _assistant_message_end_ms(msg: dict[str, Any], now_ms: int) -> float:
    tm = _record(_info(msg).get("time"))
    created = tm.get("created") or 0
    end = tm.get("completed") if isinstance(tm.get("completed"), (int, float)) else created
    for p in _parts(msg):
        if p.get("type") == "tool" and _record(p.get("state")).get("status") in {"running", "pending"}:
            end = max(float(end or 0), float(now_ms))
    return float(end or 0)


def _compute_subtask_duration(assistant_indices: list[int], all_messages: list[dict[str, Any]], now_ms: int) -> float | None:
    if not assistant_indices:
        return None
    sorted_indices = sorted(set(assistant_indices))
    chunks: list[list[int]] = []
    cur = [sorted_indices[0]]
    for idx in sorted_indices[1:]:
        if idx == cur[-1] + 1:
            cur.append(idx)
        else:
            chunks.append(cur)
            cur = [idx]
    chunks.append(cur)
    total = 0.0
    for chunk in chunks:
        msgs = [all_messages[i] for i in chunk if i < len(all_messages)]
        if not msgs:
            continue
        starts = [_record(_info(m).get("time")).get("created") for m in msgs]
        starts = [float(x) for x in starts if isinstance(x, (int, float))]
        if not starts:
            continue
        mn = min(starts)
        mx = max(_assistant_message_end_ms(m, now_ms) for m in msgs)
        if mx >= mn:
            total += mx - mn
    return total if total > 0 else None


def _subtask_metrics(st: dict[str, Any], messages: list[dict[str, Any]], display_index: int, additional_messages: list[dict[str, Any]], now_ms: int) -> dict[str, Any]:
    indices = [i for i in _list(st.get("assistantMessageIndices")) if isinstance(i, int)]
    msgs = [messages[i] for i in indices if i < len(messages)]
    bd = trace_tokens_from_messages(msgs)
    child_bd = trace_tokens_from_messages(additional_messages)
    token_breakdown = {k: bd[k] + child_bd[k] for k in bd}
    return {
        "title": _derive_subtask_title(st, messages, display_index),
        "durationMs": _compute_subtask_duration(indices, messages, now_ms),
        "tokensTotal": token_breakdown["total"],
        "tokenBreakdown": token_breakdown,
        "llmCallCount": len(msgs) + len([m for m in additional_messages if _info(m).get("role") == "assistant"]),
        "cost": cost_from_messages(msgs) + cost_from_messages(additional_messages),
    }


def build_turn_trace(
    messages: list[dict[str, Any]],
    end_assistant_message_id: str,
    session: dict[str, Any] | None = None,
    now_ms: int | None = None,
    child_messages_by_session_id: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any] | None:
    child_messages_by_session_id = child_messages_by_session_id or {}
    now_ms = now_ms or _now_ms()
    end_index = next((i for i, m in enumerate(messages) if _info(m).get("id") == end_assistant_message_id), -1)
    if end_index < 0 or not is_assistant_stop_message(messages[end_index]):
        return None
    start_index = -1
    for i in range(end_index, -1, -1):
        if _info(messages[i]).get("role") == "user":
            start_index = i
            break
    if start_index < 0:
        return None
    turn_messages = messages[start_index : end_index + 1]
    user_message = turn_messages[0]
    end_message = messages[end_index]
    subtasks = group_assistant_subtasks(turn_messages)
    trace_subtasks: list[dict[str, Any]] = []
    for subtask_index, subtask in enumerate(subtasks):
        indices = sorted([*subtask.get("userMessageIndices", []), *subtask.get("assistantMessageIndices", [])])
        segment_messages = [turn_messages[i] for i in indices if isinstance(i, int) and i < len(turn_messages)]
        descriptors = _collect_task_descriptors_with_nested_children(segment_messages, child_messages_by_session_id)
        segment_child_messages = _child_messages_for_descriptors(descriptors, child_messages_by_session_id)
        metrics = _subtask_metrics(subtask, turn_messages, subtask_index, segment_child_messages, now_ms)
        trace_subtasks.append(
            {
                "index": subtask_index,
                "subtaskId": subtask.get("subtask_id"),
                "title": metrics["title"],
                "phase": subtask.get("phase"),
                "todos": subtask.get("todos") or [],
                "metrics": {
                    "durationMs": metrics["durationMs"],
                    "tokensTotal": metrics["tokensTotal"],
                    "tokenBreakdown": metrics["tokenBreakdown"],
                    "llmCallCount": metrics["llmCallCount"],
                    "cost": metrics["cost"],
                },
                "actions": _build_merged_subtask_actions(segment_messages, child_messages_by_session_id, now_ms),
            }
        )
    all_child_messages = [m for msgs in child_messages_by_session_id.values() for m in msgs]
    metrics_messages = [*turn_messages, *all_child_messages] if all_child_messages else turn_messages
    end_info = _info(end_message)
    end_time = _record(end_info.get("time"))
    created = end_time.get("created")
    completed = end_time.get("completed")
    model = _record(end_info.get("model"))
    sess = session or {}
    duration = completed - created if isinstance(created, (int, float)) and isinstance(completed, (int, float)) and completed >= created else None
    turn = {
        "userInput": _user_text(user_message),
        "startUserMessageId": str(_info(user_message).get("id") or ""),
        "endAssistantMessageId": end_assistant_message_id,
        "startIndex": start_index,
        "endIndex": end_index,
        "finish": _get_message_finish(end_message) or "stop",
        "created": created,
        "completed": completed,
        "durationMs": duration,
        "modelID": model.get("modelID"),
        "providerID": model.get("providerID"),
        "tokens": trace_tokens_from_messages(metrics_messages),
        "cost": cost_from_messages(metrics_messages),
    }
    turn = {k: v for k, v in turn.items() if v is not None}
    return {
        "schemaVersion": "trace.v1",
        "generatedAt": _iso_now_ms(now_ms),
        "session": {
            "id": sess.get("id") or end_info.get("sessionID") or "",
            **({"title": sess.get("title")} if sess.get("title") else {}),
            **({"directory": sess.get("directory")} if sess.get("directory") else {}),
        },
        "turn": turn,
        "subtasks": trace_subtasks,
    }


def build_subtask_panel_trace(
    messages: list[dict[str, Any]],
    subtask_id: str,
    session: dict[str, Any] | None = None,
    directory: str | None = None,
    fetch_messages: Callable[[str, str | None], list[dict[str, Any]]] | None = None,
    now_ms: int | None = None,
) -> dict[str, Any] | None:
    """Build a single-panel trace.v1 for one sealed subtask (no assistant stop required)."""
    subtask_id = str(subtask_id or "").strip()
    if not subtask_id or not messages:
        return None
    if fetch_messages is None:
        fetch_messages = lambda _sid, _dir: []
    now_ms = now_ms or _now_ms()

    grouped = group_assistant_subtasks(messages)
    target: dict[str, Any] | None = None
    target_index = -1
    for i, st in enumerate(grouped):
        if str(st.get("subtask_id") or "") == subtask_id:
            target = st
            target_index = i
            break
    if target is None:
        return None

    assistant_indices = [idx for idx in _list(target.get("assistantMessageIndices")) if isinstance(idx, int)]
    user_indices = [idx for idx in _list(target.get("userMessageIndices")) if isinstance(idx, int)]
    if not assistant_indices:
        return None
    last_assistant_idx = max(assistant_indices)
    if last_assistant_idx < 0 or last_assistant_idx >= len(messages):
        return None
    end_message = messages[last_assistant_idx]
    end_info = _info(end_message)
    end_id = str(end_info.get("id") or "").strip()
    if not end_id:
        return None

    start_index = min(user_indices) if user_indices else min(assistant_indices)
    for i in range(min(assistant_indices), -1, -1):
        if _info(messages[i]).get("role") == "user":
            start_index = i
            break
    user_message = messages[start_index] if 0 <= start_index < len(messages) else None

    indices = sorted({*user_indices, *assistant_indices})
    segment_messages = [messages[i] for i in indices if 0 <= i < len(messages)]
    child_messages_by_session_id = fetch_child_messages_for_turn(segment_messages, directory, fetch_messages)
    descriptors = _collect_task_descriptors_with_nested_children(segment_messages, child_messages_by_session_id)
    segment_child_messages = _child_messages_for_descriptors(descriptors, child_messages_by_session_id)
    metrics = _subtask_metrics(target, messages, target_index, segment_child_messages, now_ms)

    end_time = _record(end_info.get("time"))
    created = end_time.get("created")
    completed = end_time.get("completed")
    model = _record(end_info.get("model"))
    sess = session or {}
    duration = (
        completed - created
        if isinstance(created, (int, float)) and isinstance(completed, (int, float)) and completed >= created
        else None
    )
    metrics_messages = [*segment_messages, *segment_child_messages] if segment_child_messages else segment_messages
    turn = {
        "userInput": _user_text(user_message) if user_message else "",
        "startUserMessageId": str(_info(user_message).get("id") or "") if user_message else "",
        "endAssistantMessageId": end_id,
        "startIndex": start_index,
        "endIndex": last_assistant_idx,
        "finish": _get_message_finish(end_message) or "panel-sealed",
        "created": created,
        "completed": completed,
        "durationMs": duration,
        "modelID": model.get("modelID"),
        "providerID": model.get("providerID"),
        "tokens": trace_tokens_from_messages(metrics_messages),
        "cost": cost_from_messages(metrics_messages),
    }
    turn = {k: v for k, v in turn.items() if v is not None}
    return {
        "schemaVersion": "trace.v1",
        "generatedAt": _iso_now_ms(now_ms),
        "session": {
            "id": sess.get("id") or end_info.get("sessionID") or "",
            **({"title": sess.get("title")} if sess.get("title") else {}),
            **({"directory": sess.get("directory") or directory} if (sess.get("directory") or directory) else {}),
        },
        "turn": turn,
        "subtasks": [
            {
                "index": 0,
                "subtaskId": target.get("subtask_id"),
                "title": metrics["title"],
                "phase": target.get("phase"),
                "todos": target.get("todos") or [],
                "metrics": {
                    "durationMs": metrics["durationMs"],
                    "tokensTotal": metrics["tokensTotal"],
                    "tokenBreakdown": metrics["tokenBreakdown"],
                    "llmCallCount": metrics["llmCallCount"],
                    "cost": metrics["cost"],
                },
                "actions": _build_merged_subtask_actions(segment_messages, child_messages_by_session_id, now_ms),
            }
        ],
    }


def build_turns_for_message_window(
    messages: list[dict[str, Any]],
    primary_end_assistant_message_id: str,
    session: dict[str, Any] | None,
    directory: str | None,
    max_turns: int,
    fetch_messages: Callable[[str, str | None], list[dict[str, Any]]],
    now_ms: int,
) -> list[dict[str, Any]]:
    end_ids = select_turn_end_ids_for_session_ingest(messages, primary_end_assistant_message_id, max_turns)
    if not end_ids:
        return []
    child_maps = []
    for end_id in end_ids:
        sliced = slice_messages_for_turn(messages, end_id)
        child_maps.append(fetch_child_messages_for_turn(sliced or [], directory, fetch_messages) if sliced else {})
    child_messages_by_session_id: dict[str, list[dict[str, Any]]] = {}
    for cmap in child_maps:
        for sid, msgs in cmap.items():
            if msgs and sid not in child_messages_by_session_id:
                child_messages_by_session_id[sid] = msgs
    turns: list[dict[str, Any]] = []
    for end_id in end_ids:
        turn = build_turn_trace(messages, end_id, session, now_ms, child_messages_by_session_id)
        if turn:
            turns.append(turn)
    return turns


def build_session_trace_bundle(
    messages: list[dict[str, Any]],
    primary_end_assistant_message_id: str,
    session: dict[str, Any] | None,
    directory: str | None,
    max_turns: int = DEFAULT_TRACE_SESSION_TURN_LIMIT,
    fetch_messages: Callable[[str, str | None], list[dict[str, Any]]] | None = None,
    now_ms: int | None = None,
) -> dict[str, Any] | None:
    if fetch_messages is None:
        fetch_messages = lambda _sid, _dir: []
    now_ms = now_ms or _now_ms()
    max_turns = max(1, int(max_turns or DEFAULT_TRACE_SESSION_TURN_LIMIT))
    turns = build_turns_for_message_window(
        messages,
        primary_end_assistant_message_id,
        session,
        directory,
        max_turns,
        fetch_messages,
        now_ms,
    )
    if not turns:
        return None
    current_turn, *older_newest_first = turns
    return {
        "schemaVersion": "trace.session.v1",
        "generatedAt": _iso_now_ms(now_ms),
        "session": current_turn.get("session") or {},
        "current_turn": current_turn,
        "history": list(reversed(older_newest_first)),
        "ingest": {
            "turnLimit": max_turns,
            "primaryEndAssistantMessageId": primary_end_assistant_message_id,
        },
    }


def _session_info(session: dict[str, Any] | None, fallback_id: str, directory: str | None = None) -> dict[str, Any]:
    sess = session or {}
    return {
        "id": sess.get("id") or fallback_id,
        **({"title": sess.get("title")} if sess.get("title") else {}),
        **({"directory": sess.get("directory") or directory} if (sess.get("directory") or directory) else {}),
    }


def _build_source_turns(
    parent_messages: list[dict[str, Any]],
    anchor_message_id: str,
    session: dict[str, Any],
    directory: str | None,
    fetch_messages: Callable[[str, str | None], list[dict[str, Any]]],
    now_ms: int,
) -> list[dict[str, Any]]:
    stop_ids = find_turn_ends_from_anchor(parent_messages, anchor_message_id, 3)
    if not stop_ids:
        return []
    child_maps = []
    for end_id in stop_ids:
        sliced = slice_messages_for_turn(parent_messages, end_id)
        child_maps.append(fetch_child_messages_for_turn(sliced or [], directory, fetch_messages) if sliced else {})
    child_messages_by_session_id: dict[str, list[dict[str, Any]]] = {}
    for cmap in child_maps:
        for sid, msgs in cmap.items():
            if msgs and sid not in child_messages_by_session_id:
                child_messages_by_session_id[sid] = msgs
    turns: list[dict[str, Any]] = []
    for end_id in stop_ids:
        turn = build_turn_trace(parent_messages, end_id, session, now_ms, child_messages_by_session_id)
        if turn:
            turns.append(turn)
    return turns


def build_fork_comparison(
    fork_meta: dict[str, Any],
    directory: str | None,
    fetch_messages: Callable[[str, str | None], list[dict[str, Any]]],
    now_ms: int | None = None,
) -> dict[str, Any] | None:
    anchor = str(fork_meta.get("forkAnchorMessageId") or "").strip()
    source_parent = str(fork_meta.get("sourceParentSessionId") or "").strip()
    if not anchor or not source_parent:
        return None
    now_ms = now_ms or _now_ms()
    parent_messages = fetch_messages(source_parent, directory)
    source_session = {"id": source_parent, "directory": directory}
    source_turns = _build_source_turns(parent_messages, anchor, source_session, directory, fetch_messages, now_ms)
    if not source_turns:
        return None
    meta = {
        "forkAnchorMessageId": anchor,
        **({"forkAnchorPartId": fork_meta.get("forkAnchorPartId")} if fork_meta.get("forkAnchorPartId") else {}),
        "sourceParentSessionId": source_parent,
        "forkedSessionId": str(fork_meta.get("forkedSessionId") or "").strip(),
    }
    return {
        "meta": meta,
        "session": _session_info(source_session, source_parent, directory),
        "sourceTurns": source_turns,
    }
