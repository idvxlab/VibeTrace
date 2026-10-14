from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import re
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import uuid4
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parent.parent
WORKER_ROOT = Path(__file__).resolve().parent
LOG_ROOT = REPO_ROOT / "memory_worker" / "logs"
PROMPT_ROOT = REPO_ROOT / "memory_worker" / "prompts"
INGEST_DEDUP_INDEX = LOG_ROOT / "ingest-dedup-index.json"
TASK_SWITCH_STATE_PATH = LOG_ROOT / "task-switch-state.json"
TASK_SKILL_INDEX_PATH = LOG_ROOT / "task-skill-index.json"
SKILL_HISTORY_INDEX_PATH = LOG_ROOT / "skill-history-index.json"
TASK_SEGMENTS_INDEX_PATH = LOG_ROOT / "task-segments-index.json"
ERROR_DIAGNOSIS_INDEX_PATH = LOG_ROOT / "error-diagnosis-index.json"
INGEST_DEDUP_STALE_RUNNING_SEC = 900
ERROR_DIAGNOSIS_RUNNING_STALE_SEC = 900
_ingest_dedup_lock = threading.Lock()
_task_switch_lock = threading.Lock()
_task_segments_lock = threading.Lock()
_error_diagnosis_lock = threading.Lock()

_TRACE_PARSER_SPEC = importlib.util.spec_from_file_location("trace_parser", WORKER_ROOT / "trace_parser.py")
if _TRACE_PARSER_SPEC is None or _TRACE_PARSER_SPEC.loader is None:
    raise RuntimeError("failed to load memory_worker/trace_parser.py")
trace_parser = importlib.util.module_from_spec(_TRACE_PARSER_SPEC)
_TRACE_PARSER_SPEC.loader.exec_module(trace_parser)

# skill_evolve package lives under memory_worker/; ensure importable without install.
if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))


def load_env_file(path: Path, *, override: bool = False) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if not k:
            continue
        if override or k not in os.environ:
            os.environ[k] = v.strip()


load_env_file(REPO_ROOT / ".env")
load_env_file(REPO_ROOT / ".env.local", override=True)


def resolve_config_path(raw: str | os.PathLike[str] | None, default: Path) -> Path:
    value = str(raw or "").strip()
    path = Path(value).expanduser() if value else default
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path.resolve()


def split_env_paths(raw: str | None) -> list[Path]:
    roots: list[Path] = []
    for part in (raw or "").split(";"):
        value = part.strip()
        if not value:
            continue
        roots.append(resolve_config_path(value, REPO_ROOT))
    return roots

OPENCODE_BASE = (os.environ.get("OPENCODE_BASE") or os.environ.get("VITE_OPENCODE_BASE") or "http://127.0.0.1:4096").rstrip("/")
OPENCODE_DIRECTORY = str(resolve_config_path(os.environ.get("OPENCODE_DIRECTORY"), REPO_ROOT))
SKILL_WRITE_ROOT = resolve_config_path(os.environ.get("SKILL_WRITE_ROOT"), Path.home() / ".claude" / "skills")
SKILL_LOAD_ROOTS = split_env_paths(os.environ.get("SKILL_LOAD_ROOTS"))
SKILL_SEARCH_ROOTS_EXTRA = split_env_paths(os.environ.get("SKILL_SEARCH_ROOTS_EXTRA"))
MW_ANALYZER_MODE = (os.environ.get("MW_ANALYZER_MODE") or "opencode").strip().lower()
# opencode / opencode_content / llm: OpenCode generates file contents as JSON only;
# memory_worker always performs disk writes (avoids external_directory permission asks).
MW_WRITER_MODE = (os.environ.get("MW_WRITER_MODE") or "opencode").strip().lower()
MW_TASK_SWITCH_MODE = (os.environ.get("MW_TASK_SWITCH_MODE") or "opencode").strip().lower()
# skill_evolve = vibetrace-skill online distill; legacy = analyzer+writer
# chinese branch default: legacy (analyzer+writer). Set MW_SKILL_PIPELINE=skill_evolve to opt in.
MW_SKILL_PIPELINE = (os.environ.get("MW_SKILL_PIPELINE") or "legacy").strip().lower()
MW_SESSION_STRATEGY = (os.environ.get("MW_SESSION_STRATEGY") or "new").strip().lower()
MW_SESSION_TITLE_PREFIX = (os.environ.get("MW_SESSION_TITLE_PREFIX") or "[mw-internal]").strip()
MW_CORS_ORIGINS = [x.strip() for x in (os.environ.get("MW_CORS_ORIGINS") or "http://localhost:5173;http://127.0.0.1:5173").split(";") if x.strip()]
MW_ANALYZER_SESSION_ATTEMPTS = max(1, int(os.environ.get("MW_ANALYZER_SESSION_ATTEMPTS") or "5"))
INGEST_DEDUP_FAILED_COOLDOWN_SEC = max(60, int(os.environ.get("INGEST_DEDUP_FAILED_COOLDOWN_SEC") or "600"))

# OpenCode HTTP timeouts (internal constants, not from env)
MW_OPENCODE_HTTP_TIMEOUT_SEC = 60
MW_OPENCODE_MESSAGE_TIMEOUT_SEC = 180
MW_ANALYZER_WAIT_PER_ATTEMPT_SEC = 180

# Same free default as frontend `VIBETRACE_DEFAULT_MODEL_REF` (`src/config/opencodeDefaults.ts`).
# Every worker → OpenCode message MUST send an explicit model; never fall back to user config.
MW_DEFAULT_MODEL_REF = (
    (os.environ.get("MW_OPENCODE_MODEL") or "").strip() or "opencode/big-pickle"
)



def parse_worker_port() -> int:
    if os.environ.get("MEMORY_WORKER_PORT", "").strip().isdigit():
        return int(os.environ["MEMORY_WORKER_PORT"])
    base = os.environ.get("VITE_MEMORY_WORKER_BASE", "").strip()
    if base:
        m = re.search(r":(\d+)$", base.rstrip("/"))
        if m:
            return int(m.group(1))
    return 8714


PORT = parse_worker_port()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_log(path: Path, event: str, payload: dict[str, Any]) -> None:
    line = json.dumps({"ts": now_iso(), "event": event, "payload": payload}, ensure_ascii=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(f"[memory-worker] {event} {payload}")


def write_summary(run_dir: Path, summary: dict[str, Any]) -> None:
    write_json(run_dir / "00-summary.json", summary)


def ensure_prompt_files() -> None:
    PROMPT_ROOT.mkdir(parents=True, exist_ok=True)
    analyzer = PROMPT_ROOT / "analyzer_prompt.md"
    writer = PROMPT_ROOT / "writer_prompt.md"
    if not analyzer.exists():
        analyzer.write_text(
            (
                "你是 Skill 分析器（Judge）。根据 trace 与 pool_summary，仅输出单个 JSON 对象，不要解释性文字。\n\n"
                "要求：\n"
                "1) operation 只能是 CREATE / UPDATE / NONE\n"
                "2) NONE：skill_name='' 且 source_skill_absolute_path=''\n"
                "3) UPDATE：source_skill_absolute_path 须非空且来自 pool_summary\n"
                "4) guide 须含 folders、file_guidance、skill_md、trace_anchors\n\n"
                "输出 schema：SkillJudgeEnvelope v2.0。\n\n"
                "trace:\n{{TRACE_JSON}}\n\n"
                "pool_summary:\n{{POOL_SUMMARY_JSON}}\n"
            ),
            encoding="utf-8",
        )
    switcher = PROMPT_ROOT / "task_switch_prompt.md"
    if not switcher.exists():
        switcher.write_text(
            (
                "你是 TaskSwitchJudge。仅根据用户输入，判断任务是否从上一段切换到当前输入。\n\n"
                "输入 JSON 含 previous_user_prompts（自上次提取以来累积的用户输入，旧→新）"
                "与 current_user_prompt（本轮用户输入）。不要使用 agent 执行信息。\n\n"
                "当当前输入开启新目标、交付物或问题域，而非对上一任务的补充、纠正、继续、验证或格式调整时，"
                "设 task_switched=true。\n\n"
                "仅输出 JSON 对象：\n"
                "{\"task_switched\": boolean, \"confidence\": \"low|medium|high\", "
                "\"reason\": \"string\", "
                "\"previous_task\": {\"title\": \"string\", \"description\": \"string\"}, "
                "\"current_task\": {\"title\": \"string\", \"description\": \"string\"}}\n\n"
                "input:\n{{TASK_SWITCH_INPUT_JSON}}\n"
            ),
            encoding="utf-8",
        )
    feedback = PROMPT_ROOT / "feedback_distill_prompt.md"
    if not feedback.exists():
        feedback.write_text(
            (
                "你是 FeedbackSkillDistiller。你将收到任务段、整体用户反馈，"
                "以及用户对一个或多个 trace 面板的局部反馈。\n\n"
                "目标：将反馈蒸馏为可复用 skill 草稿，指导 agent 处理类似任务/trace 模式。\n\n"
                "当输入中 feedbackContext.traceKind=\"feedback\" 时，这是分析器 trace 的反馈蒸馏变体；"
                "selectedPanels 仅含用户选中的面板 trace — 不要分析未选中的面板。\n\n"
                "要求：\n"
                "1. 仅输出 JSON；无 Markdown、说明或代码围栏。\n"
                "2. skill_name 使用 kebab-case，简短稳定。\n"
                "3. description 描述触发场景；不要仅复述任务 id。\n"
                "4. steps 须为可执行的行为规则。\n"
                "5. trace_anchors 应引用输入中的 subtaskIndex/actionKey/messageId 等，说明反馈来源。\n"
                "6. 若信息不足以蒸馏 skill，输出 operation=\"NONE\" 并在 rationale 中说明原因。\n\n"
                "输出 schema：\n"
                "{\n"
                "  \"operation\": \"CREATE\" | \"UPDATE\" | \"NONE\",\n"
                "  \"skill_name\": \"string\",\n"
                "  \"description\": \"string\",\n"
                "  \"rationale\": \"string\",\n"
                "  \"trigger_conditions\": [\"string\"],\n"
                "  \"steps\": [\"string\"],\n"
                "  \"constraints\": [\"string\"],\n"
                "  \"trace_anchors\": [\n"
                "    {\n"
                "      \"subtaskIndex\": 0,\n"
                "      \"summary\": \"string\",\n"
                "      \"actionKeys\": [\"string\"],\n"
                "      \"messageIds\": [\"string\"]\n"
                "    }\n"
                "  ]\n"
                "}\n\n"
                "input:\n{{FEEDBACK_DISTILL_INPUT_JSON}}\n"
            ),
            encoding="utf-8",
        )
    error_diagnosis = PROMPT_ROOT / "error_diagnosis_prompt.md"
    if not error_diagnosis.exists():
        error_diagnosis.write_text(
            (
                "你是 VibeTrace 面板分析器。你将收到已完成的子任务 trace，可能成功或含失败动作。\n\n"
                "目标：为该 trace 面板生成最简解读。无错误时用一句话说明用途、做了什么、最终得到什么。"
                "有错误时先给同样形式的一句话过程摘要，再写纠错、根因与因果：失败点、根因、为何出错、如何修复。\n\n"
                "要求：\n"
                "1. 仅输出 JSON；无 Markdown、说明或代码围栏。\n"
                "2. summary 须为一句话，尽可能短，形式接近「为 X，执行了 Y，最终得到 Z」。\n"
                "3. 严格从 input.subtask.actions 与 input.errorActions 归纳；不要编造 trace 中不存在的目标、结果、文件、页面或错误。\n"
                "4. 描述整体步骤，不要逐动作流水账；保持简洁可读。\n"
                "5. JSON 字符串内不要使用未转义的 ASCII 双引号；引用用户时用书名号、单引号或省略引号。\n"
                "6. 若 input.hasError=false，rootCause、causalChain、evidence、fixSuggestion 须为空字符串或空数组；confidence 反映 trace 完整度。\n"
                "7. 若 input.hasError=true，仅根据输入 trace 证据推理；证据不足时设 confidence=\"low\"。\n"
                "8. 有错误时区分表面错误与根因（如路径错误、缺少校验、并发子任务失败）。\n"
                "9. causalChain、evidence、fixSuggestion 可选；仅在有明确证据时填写，否则保持空以避免冗长。\n\n"
                "输出 schema：\n"
                "{\n"
                "  \"summary\": \"一句话：面板用途、做了什么、产出什么\",\n"
                "  \"rootCause\": \"无错误时为空；有错误时为根因\",\n"
                "  \"causalChain\": [],\n"
                "  \"evidence\": [],\n"
                "  \"fixSuggestion\": \"无错误时为空；有错误时为下一步建议\",\n"
                "  \"confidence\": \"high\" | \"medium\" | \"low\"\n"
                "}\n\n"
                "input:\n{{ERROR_DIAGNOSIS_INPUT_JSON}}\n"
            ),
            encoding="utf-8",
        )
    if not writer.exists():
        writer.write_text(
            (
                "你是 Skill 文案生成器。只输出含 files[].content 的 JSON；禁止使用工具写盘。\n"
                "- CREATE / UPDATE：生成 SKILL.md 等文件完整内容\n"
                "- NONE：status=skipped\n"
                "落盘由 memory_worker 完成。\n"
            ),
            encoding="utf-8",
        )


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


def trace_primary_turn(trace: dict[str, Any]) -> dict[str, Any]:
    """Triggering turn: `current_turn`, legacy `turns[0]`, or trace.v1 root."""
    if trace.get("schemaVersion") == "trace.session.v1":
        current = trace.get("current_turn")
        if isinstance(current, dict):
            return current
        turns = trace.get("turns")
        if isinstance(turns, list) and turns and isinstance(turns[0], dict):
            return turns[0]
        return {}
    if trace.get("schemaVersion") == "trace.v1":
        return trace
    return {}


def trace_chronological_turns(trace: dict[str, Any]) -> list[dict[str, Any]]:
    """Session bundle turns oldest → newest; single trace.v1 as one-element list."""
    if trace.get("schemaVersion") == "trace.session.v1":
        history = trace.get("history")
        current = trace.get("current_turn")
        out: list[dict[str, Any]] = []
        if isinstance(history, list):
            out.extend([x for x in history if isinstance(x, dict)])
        if isinstance(current, dict):
            out.append(current)
        if out:
            return out
        turns = trace.get("turns")
        if isinstance(turns, list):
            legacy = [x for x in turns if isinstance(x, dict)]
            return list(reversed(legacy))
        return []
    if trace.get("schemaVersion") == "trace.v1":
        return [trace]
    return []


def trace_primary_end_message_id(trace: dict[str, Any]) -> str:
    ingest = trace.get("ingest") if trace.get("schemaVersion") == "trace.session.v1" else {}
    if isinstance(ingest, dict):
        primary = str(ingest.get("primaryEndAssistantMessageId") or "").strip()
        if primary:
            return primary
    primary_turn = trace_primary_turn(trace)
    return str(((primary_turn.get("turn") or {}).get("endAssistantMessageId") or "")).strip()


def trace_session_id(trace: dict[str, Any]) -> str:
    primary_turn = trace_primary_turn(trace)
    sid = str(((primary_turn.get("session") or trace.get("session") or {}).get("id") or "")).strip()
    return sid


def build_run_id(trace: dict[str, Any]) -> str:
    sid = trace_session_id(trace) or "unknown-session"
    end_msg = trace_primary_end_message_id(trace) or "unknown-turn"
    safe = lambda s: re.sub(r"[^a-zA-Z0-9_-]", "_", s)
    stamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S-%f")
    return f"{stamp}-{safe(sid)}-{safe(end_msg)}-{uuid4().hex[:8]}"


def trace_ingest_dedup_key(trace: dict[str, Any]) -> str:
    sid = trace_session_id(trace)
    end_msg = trace_primary_end_message_id(trace)
    if not sid or not end_msg:
        return ""
    return f"{sid}:{end_msg}"


def _load_task_switch_state() -> dict[str, Any]:
    if not TASK_SWITCH_STATE_PATH.exists():
        return {"sessions": {}}
    try:
        data = json.loads(TASK_SWITCH_STATE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            sessions = data.get("sessions")
            if isinstance(sessions, dict):
                return data
    except Exception:
        pass
    return {"sessions": {}}


def _save_task_switch_state(data: dict[str, Any]) -> None:
    data["updatedAt"] = now_iso()
    write_json(TASK_SWITCH_STATE_PATH, data)


def _turn_record_for_state(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "userInput": str(record.get("userInput") or ""),
        "startUserMessageId": str(record.get("startUserMessageId") or ""),
        "endAssistantMessageId": str(record.get("endAssistantMessageId") or ""),
        "startIndex": record.get("startIndex"),
        "endIndex": record.get("endIndex"),
        "created": record.get("created"),
        "completed": record.get("completed"),
    }


def _dedupe_turn_records(turns: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    if not isinstance(turns, list):
        return out
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        end_id = str(turn.get("endAssistantMessageId") or "").strip()
        if not end_id or end_id in seen:
            continue
        seen.add(end_id)
        out.append(_turn_record_for_state(turn))
    return out


def _find_turn_prompt_record(records: list[dict[str, Any]], end_assistant_message_id: str) -> dict[str, Any] | None:
    for record in records:
        if str(record.get("endAssistantMessageId") or "") == end_assistant_message_id:
            return record
    return None


def _normalize_user_prompt(text: str) -> str:
    """Strip harness preamble so early prompt and completed-turn records compare equally."""
    return trace_parser._strip_harness_guidance(str(text or "")).strip()


def _prompt_fingerprint(text: str) -> str:
    return re.sub(r"\s+", " ", _normalize_user_prompt(text)).lower()


def _same_user_prompt(left: str, right: str) -> bool:
    a = _prompt_fingerprint(left)
    b = _prompt_fingerprint(right)
    return bool(a and b and a == b)


def _task_switch_decision_ready(task_switch: Any) -> bool:
    if not isinstance(task_switch, dict):
        return False
    decision = task_switch.get("decision")
    return isinstance(decision, dict) and isinstance(decision.get("task_switched"), bool)


def _completed_in_flight_turn(session_state: dict[str, Any], user_prompt: str) -> dict[str, Any] | None:
    completed = session_state.get("completedInFlightTurn")
    if isinstance(completed, dict) and _same_user_prompt(str(completed.get("userInput") or ""), user_prompt):
        return _turn_record_for_state(completed)
    return None


def _task_switch_session_key(session_id: str, directory: str | None) -> str:
    directory_key = (directory or OPENCODE_DIRECTORY or "").strip()
    return f"{session_id}::{directory_key}"


def task_switch_input_payload(pending_turns: list[dict[str, Any]], current_turn: dict[str, Any]) -> dict[str, Any]:
    return {
        "previous_user_prompts": [
            {
                "turn_index": idx,
                "endAssistantMessageId": str(turn.get("endAssistantMessageId") or ""),
                "user_prompt": str(turn.get("userInput") or ""),
            }
            for idx, turn in enumerate(pending_turns)
        ],
        "current_user_prompt": {
            "endAssistantMessageId": str(current_turn.get("endAssistantMessageId") or ""),
            "user_prompt": str(current_turn.get("userInput") or ""),
        },
    }


def render_task_switch_prompt(template: str, pending_turns: list[dict[str, Any]], current_turn: dict[str, Any]) -> str:
    payload = task_switch_input_payload(pending_turns, current_turn)
    return template.replace("{{TASK_SWITCH_INPUT_JSON}}", json.dumps(payload, ensure_ascii=False, indent=2))


def _summarize_user_input(text: str, *, max_len: int = 120) -> str:
    clean = re.sub(r"\s+", " ", str(text or "")).strip()
    if not clean:
        return ""
    if len(clean) <= max_len:
        return clean
    return clean[: max_len - 1].rstrip() + "…"


def _mock_task_switch_decision(pending_turns: list[dict[str, Any]], current_turn: dict[str, Any]) -> dict[str, Any]:
    text = str(current_turn.get("userInput") or "").strip().lower()
    switched = bool(
        re.search(
            r"(新任务|另一个任务|换个任务|完全不同|接下来做|现在.*(实现|分析|修复|创建)|new task|different task)",
            text,
            flags=re.I,
        )
    )
    previous_text = " / ".join(str(x.get("userInput") or "") for x in pending_turns)
    current_text = str(current_turn.get("userInput") or "")
    return {
        "task_switched": switched,
        "confidence": "medium" if switched else "low",
        "reason": "mock heuristic matched task-switch phrase" if switched else "mock heuristic found no explicit switch phrase",
        "previous_task": {
            "title": _summarize_user_input(previous_text, max_len=16) if switched else "",
            "description": _summarize_user_input(previous_text, max_len=36) if switched else "",
        },
        "current_task": {
            "title": _summarize_user_input(current_text, max_len=16),
            "description": _summarize_user_input(current_text, max_len=36),
        },
    }


def _record_json_parse_outcome(
    *,
    phase: str,
    raw_text: str,
    parsed: Any,
    salvaged: bool,
    log_file: Path | None = None,
    run_dir: Path | None = None,
    error: str | None = None,
) -> None:
    payload: dict[str, Any] = {
        "phase": phase,
        "strictParseOk": parsed is not None and not salvaged and not error,
        "salvaged": salvaged,
        "error": error,
        "rawPreview": (raw_text or "")[:1200],
    }
    if isinstance(parsed, (dict, list)):
        payload["parsedPreview"] = parsed
    if log_file is not None:
        if error:
            append_log(log_file, "json.parse.failed", payload)
        elif salvaged:
            append_log(log_file, "json.parse.salvaged", payload)
        else:
            append_log(log_file, "json.parse.ok", {"phase": phase})
    if run_dir is not None and (salvaged or error):
        write_json(run_dir / "00-json-parse-salvage.json", payload)


def _extract_json_string_field_before(text: str, field: str, next_field: str) -> str:
    """Pull a string field when the model embeds unescaped quotes inside the value."""
    marker = f'"{field}"'
    idx = text.find(marker)
    if idx < 0:
        return ""
    colon = text.find(":", idx + len(marker))
    if colon < 0:
        return ""
    quote = text.find('"', colon + 1)
    if quote < 0:
        return ""
    next_marker = f'"{next_field}"'
    next_idx = text.find(next_marker, quote + 1)
    if next_idx < 0:
        return ""
    body = text[quote + 1 : next_idx].rstrip()
    if body.endswith(","):
        body = body[:-1].rstrip()
    if body.endswith('"'):
        body = body[:-1]
    return body.strip()


def _parse_task_block_from_text(text: str, role: str) -> dict[str, str]:
    pattern = re.compile(
        rf'"{re.escape(role)}_task"\s*:\s*\{{\s*"title"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"description"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}}',
        flags=re.S,
    )
    match = pattern.search(text)
    if not match:
        return {"title": "", "description": ""}
    return {"title": match.group(1), "description": match.group(2)}


def _parse_task_switch_decision(
    raw_text: str,
    *,
    log_file: Path | None = None,
    run_dir: Path | None = None,
) -> dict[str, Any] | None:
    parsed = try_parse_json_object(raw_text)
    if isinstance(parsed, dict) and isinstance(parsed.get("task_switched"), bool):
        _record_json_parse_outcome(
            phase="task_switch",
            raw_text=raw_text,
            parsed=parsed,
            salvaged=False,
            log_file=log_file,
            run_dir=run_dir,
        )
        return parsed

    text = (raw_text or "").strip()
    if not text:
        _record_json_parse_outcome(
            phase="task_switch",
            raw_text=raw_text,
            parsed=None,
            salvaged=False,
            log_file=log_file,
            run_dir=run_dir,
            error="empty model output",
        )
        return None

    normalized = (
        text.replace("\u201c", "'")
        .replace("\u201d", "'")
        .replace("\u2018", "'")
        .replace("\u2019", "'")
    )
    parsed = try_parse_json_object(normalized)
    if isinstance(parsed, dict) and isinstance(parsed.get("task_switched"), bool):
        _record_json_parse_outcome(
            phase="task_switch",
            raw_text=raw_text,
            parsed=parsed,
            salvaged=True,
            log_file=log_file,
            run_dir=run_dir,
        )
        parsed["_salvaged"] = True
        return parsed

    switch_match = re.search(r'"task_switched"\s*:\s*(true|false)', text, re.I)
    if not switch_match:
        _record_json_parse_outcome(
            phase="task_switch",
            raw_text=raw_text,
            parsed=None,
            salvaged=False,
            log_file=log_file,
            run_dir=run_dir,
            error="task_switched field not found after strict parse failed",
        )
        return None

    confidence_match = re.search(r'"confidence"\s*:\s*"([^"]*)"', text, re.I)
    salvaged = {
        "task_switched": switch_match.group(1).lower() == "true",
        "confidence": (confidence_match.group(1) if confidence_match else "medium").strip() or "medium",
        "reason": _extract_json_string_field_before(text, "reason", "previous_task"),
        "previous_task": _parse_task_block_from_text(text, "previous"),
        "current_task": _parse_task_block_from_text(text, "current"),
        "_salvaged": True,
    }
    _record_json_parse_outcome(
        phase="task_switch",
        raw_text=raw_text,
        parsed=salvaged,
        salvaged=True,
        log_file=log_file,
        run_dir=run_dir,
    )
    return salvaged


def run_task_switch_judge(
    pending_turns: list[dict[str, Any]],
    current_turn: dict[str, Any],
    run_dir: Path,
    log_file: Path,
    directory: str | None = None,
) -> dict[str, Any]:
    if MW_TASK_SWITCH_MODE == "mock":
        decision = _mock_task_switch_decision(pending_turns, current_turn)
        append_log(log_file, "task_switch.mock.used", decision)
        return {"mode": "mock", "analysis": decision, "rawText": json.dumps(decision, ensure_ascii=False)}

    template = (PROMPT_ROOT / "task_switch_prompt.md").read_text(encoding="utf-8")
    prompt = render_task_switch_prompt(template, pending_turns, current_turn)
    (run_dir / "00-task-switch-prompt.txt").write_text(prompt, encoding="utf-8")
    append_log(
        log_file,
        "task_switch.prompt.ready",
        {"promptPath": str(run_dir / "00-task-switch-prompt.txt"), "pendingTurnCount": len(pending_turns)},
    )
    llm_out = opencode_generate_text(
        prompt,
        run_dir,
        log_file,
        "00a-task-switch",
        directory=directory,
        parent_session_id=None,
        retry_with_new_session=True,
    )
    parsed = _parse_task_switch_decision(
        str(llm_out.get("rawText") or ""),
        log_file=log_file,
        run_dir=run_dir,
    )
    if not isinstance(parsed, dict) or not isinstance(parsed.get("task_switched"), bool):
        raise RuntimeError("TaskSwitchJudge output parse failed")
    if parsed.pop("_salvaged", None):
        append_log(
            log_file,
            "task_switch.parse.salvaged",
            {
                "taskSwitched": parsed.get("task_switched"),
                "reasonPreview": str(parsed.get("reason") or "")[:120],
                "salvageArtifact": str(run_dir / "00-json-parse-salvage.json"),
            },
        )
    return {"mode": "opencode", **llm_out, "analysis": parsed}


def _format_task_display_label(*, title: str = "", description: str = "") -> str:
    title = str(title or "").strip()
    description = str(description or "").strip()
    if title and description:
        return f"{title} — {description}"
    return title or description


def _task_brief_from_decision(decision: Any, role: str) -> dict[str, str]:
    if not isinstance(decision, dict):
        return {"title": "", "description": ""}
    block = decision.get(f"{role}_task")
    if isinstance(block, dict):
        return {
            "title": str(block.get("title") or "").strip(),
            "description": str(block.get("description") or "").strip(),
        }
    legacy = str(decision.get(f"{role}_task_summary") or "").strip()
    if legacy:
        return {"title": "", "description": legacy}
    return {"title": "", "description": ""}


def _skip_ingest_response(
    reason: str,
    session_id: str,
    current_turn: dict[str, Any],
    pending_turns: list[dict[str, Any]],
    task_switch: dict[str, Any] | None = None,
    *,
    directory_override: str | None = None,
    task_switched: bool | None = None,
    extracted_turns: list[dict[str, Any]] | None = None,
    extracted_brief: dict[str, str] | None = None,
    pending_brief: dict[str, str] | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "ok": True,
        "skipped": True,
        "reason": reason,
        "sessionId": session_id,
        "endAssistantMessageId": str(current_turn.get("endAssistantMessageId") or ""),
        "pendingTurnCount": len(pending_turns),
    }
    if task_switch is not None:
        out["taskSwitch"] = task_switch
    if extracted_turns:
        brief = extracted_brief or {}
        out["extractedTask"] = _task_segment_summary(
            extracted_turns,
            title=brief.get("title"),
            description=brief.get("description"),
        )
    if pending_turns:
        brief = pending_brief or {}
        out["pendingTask"] = _task_segment_summary(
            pending_turns,
            title=brief.get("title"),
            description=brief.get("description"),
        )
    resolved_task_switched = bool(task_switched)
    if not resolved_task_switched and isinstance(task_switch, dict):
        decision = task_switch.get("decision")
        if isinstance(decision, dict):
            resolved_task_switched = bool(decision.get("task_switched"))
    _persist_task_segments_from_response(
        session_id,
        directory_override,
        out,
        task_switched=resolved_task_switched,
    )
    return out


def _load_task_segments_index() -> dict[str, Any]:
    if not TASK_SEGMENTS_INDEX_PATH.exists():
        return {"sessions": {}}
    try:
        data = json.loads(TASK_SEGMENTS_INDEX_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("sessions"), dict):
            return data
    except Exception:
        pass
    return {"sessions": {}}


def _save_task_segments_index(data: dict[str, Any]) -> None:
    data["updatedAt"] = now_iso()
    write_json(TASK_SEGMENTS_INDEX_PATH, data)


def _task_segment_tab_record(
    segment: dict[str, Any],
    *,
    status: str,
    task_switch_run_dir: str = "",
    pipeline_run_dir: str = "",
) -> dict[str, Any] | None:
    task_id = str(segment.get("taskId") or "").strip()
    if not task_id:
        return None
    title = str(segment.get("title") or "").strip()
    description = str(segment.get("description") or "").strip()
    summary = str(segment.get("summary") or "").strip()
    provisional = bool(segment.get("provisional"))
    if not title and not description and not provisional:
        summary = ""
    elif not summary:
        summary = _format_task_display_label(title=title, description=description)
    return {
        "taskId": task_id,
        "status": status,
        "fromStartUserMessageId": str(segment.get("fromStartUserMessageId") or ""),
        "fromEndAssistantMessageId": str(segment.get("fromEndAssistantMessageId") or ""),
        "toEndAssistantMessageId": str(segment.get("toEndAssistantMessageId") or ""),
        "turnCount": int(segment.get("turnCount") or 0),
        "title": title,
        "description": description,
        "summary": summary,
        "taskSwitchRunDir": str(task_switch_run_dir or "").strip(),
        "pipelineRunDir": str(pipeline_run_dir or "").strip(),
        "provisional": provisional,
    }


def _merge_task_tab_record(prior: dict[str, Any] | None, new: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(prior, dict):
        return new
    merged = {**prior, **new}
    for field in ("title", "description", "summary", "taskSwitchRunDir", "pipelineRunDir"):
        if not str(new.get(field) or "").strip():
            merged[field] = str(prior.get(field) or "").strip()
    return merged


def _load_task_switch_events_for_session(session_id: str) -> list[dict[str, Any]]:
    session_id = str(session_id or "").strip()
    if not session_id or not LOG_ROOT.exists():
        return []
    safe_sid = _safe_id(session_id) or session_id
    events: list[dict[str, Any]] = []
    for path in LOG_ROOT.iterdir():
        if not path.is_dir() or "task-switch" not in path.name:
            continue
        if safe_sid not in path.name and session_id not in path.name:
            continue
        raw_path = path / "00-task-switch-raw.json"
        if not raw_path.exists():
            continue
        try:
            raw = json.loads(raw_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        decision = raw.get("analysis") if isinstance(raw.get("analysis"), dict) else {}
        if not bool(decision.get("task_switched")):
            continue
        extracted_to = ""
        pending_to = ""
        state_path = path / "02-state-after.json"
        if state_path.exists():
            try:
                state_after = json.loads(state_path.read_text(encoding="utf-8"))
                if isinstance(state_after, dict):
                    extracted_range = state_after.get("lastExtractedRange")
                    if isinstance(extracted_range, dict):
                        extracted_to = str(extracted_range.get("toEndAssistantMessageId") or "")
                    in_flight = state_after.get("inFlightTurn")
                    if isinstance(in_flight, dict):
                        pending_to = str(in_flight.get("endAssistantMessageId") or "")
            except Exception:
                pass
        if not extracted_to or not pending_to:
            input_path = path / "01-task-switch-input.json"
            if input_path.exists():
                try:
                    switch_input = json.loads(input_path.read_text(encoding="utf-8"))
                    if isinstance(switch_input, dict):
                        prev_prompts = switch_input.get("previous_user_prompts")
                        if isinstance(prev_prompts, list) and prev_prompts:
                            last_prev = prev_prompts[-1]
                            if isinstance(last_prev, dict):
                                extracted_to = extracted_to or str(last_prev.get("endAssistantMessageId") or "")
                        current_prompt = switch_input.get("current_user_prompt")
                        if isinstance(current_prompt, dict):
                            pending_to = pending_to or str(current_prompt.get("endAssistantMessageId") or "")
                except Exception:
                    pass
        events.append(
            {
                "runDir": str(path),
                "extractedToEnd": extracted_to,
                "pendingToEnd": pending_to,
                "previousBrief": _task_brief_from_decision(decision, "previous"),
                "currentBrief": _task_brief_from_decision(decision, "current"),
                "mtime": path.stat().st_mtime,
            }
        )
    events.sort(key=lambda item: float(item.get("mtime") or 0))
    return events


def _enrich_task_segment_tabs(session_id: str, tabs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    if not tabs:
        return tabs, False
    events = _load_task_switch_events_for_session(session_id)
    if not events:
        return tabs, False
    latest_event = events[-1]
    enriched: list[dict[str, Any]] = []
    changed = False
    for raw_tab in tabs:
        if not isinstance(raw_tab, dict):
            continue
        has_title = bool(str(raw_tab.get("title") or "").strip())
        has_description = bool(str(raw_tab.get("description") or "").strip())
        if has_title and has_description:
            enriched.append(raw_tab)
            continue
        status = str(raw_tab.get("status") or "")
        to_end = str(raw_tab.get("toEndAssistantMessageId") or "")
        run_dir = str(raw_tab.get("taskSwitchRunDir") or "").strip()
        brief: dict[str, str] = {"title": "", "description": ""}
        for ev in events:
            if run_dir and str(ev.get("runDir") or "") == run_dir:
                brief = ev["previousBrief"] if status == "extracted" else ev["currentBrief"]
                break
            if status == "extracted" and to_end and to_end == str(ev.get("extractedToEnd") or ""):
                brief = ev["previousBrief"]
            elif status == "pending" and to_end and to_end == str(ev.get("pendingToEnd") or ""):
                brief = ev["currentBrief"]
        if status == "pending" and not brief.get("title") and not brief.get("description"):
            brief = latest_event["currentBrief"]
        updates: dict[str, str] = {}
        if not has_title and brief.get("title"):
            updates["title"] = brief["title"]
        if not has_description and brief.get("description"):
            updates["description"] = brief["description"]
        if not updates:
            enriched.append(raw_tab)
            continue
        title = updates.get("title") or str(raw_tab.get("title") or "").strip()
        description = updates.get("description") or str(raw_tab.get("description") or "").strip()
        updates["summary"] = _format_task_display_label(title=title, description=description)
        enriched.append({**raw_tab, **updates})
        changed = True
    return enriched, changed


def _persist_task_segments_index_tabs(session_id: str, directory: str | None, tabs: list[dict[str, Any]]) -> None:
    session_id = str(session_id or "").strip()
    if not session_id or not tabs:
        return
    session_key = _task_switch_session_key(session_id, directory)
    with _task_segments_lock:
        index = _load_task_segments_index()
        sessions = index.setdefault("sessions", {})
        entry = sessions.setdefault(
            session_key,
            {"sessionId": session_id, "directory": (directory or "").strip(), "tabs": []},
        )
        entry["tabs"] = tabs
        entry["updatedAt"] = now_iso()
        _save_task_segments_index(index)


def _persist_task_segments(
    session_id: str,
    directory: str | None,
    *,
    extracted_task: dict[str, Any] | None = None,
    pending_task: dict[str, Any] | None = None,
    task_switched: bool = False,
    task_switch_run_dir: str = "",
    pipeline_run_dir: str = "",
) -> None:
    session_id = str(session_id or "").strip()
    if not session_id:
        return
    extracted_record = (
        _task_segment_tab_record(
            extracted_task,
            status="extracted",
            task_switch_run_dir=task_switch_run_dir,
            pipeline_run_dir=pipeline_run_dir,
        )
        if isinstance(extracted_task, dict)
        else None
    )
    pending_record = (
        _task_segment_tab_record(
            pending_task,
            status="pending",
            task_switch_run_dir=task_switch_run_dir,
        )
        if isinstance(pending_task, dict)
        else None
    )
    if not extracted_record and not pending_record:
        return
    session_key = _task_switch_session_key(session_id, directory)
    with _task_segments_lock:
        index = _load_task_segments_index()
        sessions = index.setdefault("sessions", {})
        entry = sessions.setdefault(
            session_key,
            {"sessionId": session_id, "directory": (directory or "").strip(), "tabs": []},
        )
        tabs_by_id: dict[str, dict[str, Any]] = {}
        for tab in entry.get("tabs") if isinstance(entry.get("tabs"), list) else []:
            if not isinstance(tab, dict):
                continue
            task_id = str(tab.get("taskId") or "").strip()
            if task_id:
                tabs_by_id[task_id] = tab
        if task_switched:
            for task_id, tab in list(tabs_by_id.items()):
                if str(tab.get("status") or "") == "pending":
                    tabs_by_id[task_id] = {**tab, "status": "extracted"}
        if extracted_record:
            prior = tabs_by_id.get(extracted_record["taskId"])
            tabs_by_id[extracted_record["taskId"]] = _merge_task_tab_record(prior, extracted_record)
        if pending_record:
            for task_id, tab in list(tabs_by_id.items()):
                if str(tab.get("status") or "") != "pending":
                    continue
                if task_id == pending_record["taskId"]:
                    continue
                if str(task_id).startswith("task:pending:") or bool(tab.get("provisional")):
                    del tabs_by_id[task_id]
                    continue
                if task_switched:
                    tabs_by_id[task_id] = {**tab, "status": "extracted"}
                else:
                    del tabs_by_id[task_id]
            prior = tabs_by_id.get(pending_record["taskId"])
            tabs_by_id[pending_record["taskId"]] = _merge_task_tab_record(prior, pending_record)
        entry["tabs"] = list(tabs_by_id.values())
        entry["updatedAt"] = now_iso()
        _save_task_segments_index(index)


def _persist_task_segments_from_response(
    session_id: str,
    directory: str | None,
    response: dict[str, Any],
    *,
    task_switched: bool = False,
) -> None:
    if not isinstance(response, dict):
        return
    task_switch = response.get("taskSwitch") if isinstance(response.get("taskSwitch"), dict) else {}
    _persist_task_segments(
        session_id,
        directory,
        extracted_task=response.get("extractedTask") if isinstance(response.get("extractedTask"), dict) else None,
        pending_task=response.get("pendingTask") if isinstance(response.get("pendingTask"), dict) else None,
        task_switched=task_switched,
        task_switch_run_dir=str(task_switch.get("runDir") or ""),
        pipeline_run_dir=str(response.get("runDir") or ""),
    )


def _task_segments_from_switch_state(session_id: str) -> list[dict[str, Any]]:
    session_id = str(session_id or "").strip()
    if not session_id:
        return []
    state = _load_task_switch_state()
    sessions = state.get("sessions") if isinstance(state.get("sessions"), dict) else {}
    tabs_by_id: dict[str, dict[str, Any]] = {}
    for entry in sessions.values():
        if not isinstance(entry, dict):
            continue
        if str(entry.get("sessionId") or "").strip() != session_id:
            continue
        in_flight_switch = entry.get("inFlightTaskSwitch") if isinstance(entry.get("inFlightTaskSwitch"), dict) else {}
        decision = in_flight_switch.get("decision") if isinstance(in_flight_switch.get("decision"), dict) else {}
        switch_run_dir = str(in_flight_switch.get("runDir") or "")
        last_turns = entry.get("lastExtractedTurns")
        if isinstance(last_turns, list) and last_turns:
            brief = _task_brief_from_decision(decision, "previous") if decision else {}
            segment = _task_segment_summary(
                _dedupe_turn_records(last_turns),
                title=brief.get("title"),
                description=brief.get("description"),
            )
            record = _task_segment_tab_record(
                segment,
                status="extracted",
                task_switch_run_dir=switch_run_dir,
            )
            if record:
                tabs_by_id[record["taskId"]] = record
        pending_turns = _dedupe_turn_records(entry.get("pendingTurns") if isinstance(entry.get("pendingTurns"), list) else [])
        in_flight_turn = entry.get("inFlightTurn")
        if isinstance(in_flight_turn, dict):
            pending_turns = _dedupe_turn_records([*pending_turns, in_flight_turn])
        if pending_turns:
            brief = _task_brief_from_decision(decision, "current") if decision else {}
            segment = _task_segment_summary(
                pending_turns,
                title=brief.get("title"),
                description=brief.get("description"),
            )
            if not segment.get("taskId") and isinstance(in_flight_turn, dict):
                segment = _pending_task_segment_placeholder(
                    in_flight_turn,
                    title=brief.get("title"),
                    description=brief.get("description"),
                )
            record = _task_segment_tab_record(segment, status="pending", task_switch_run_dir=switch_run_dir)
            if record:
                tabs_by_id[record["taskId"]] = record
    return list(tabs_by_id.values())


def task_segments_for_session(session_id: str) -> dict[str, Any]:
    session_id = str(session_id or "").strip()
    if not session_id:
        return {"ok": False, "error": "sessionId is required", "count": 0, "tabs": []}
    index = _load_task_segments_index()
    sessions = index.get("sessions") if isinstance(index.get("sessions"), dict) else {}
    tabs_by_id: dict[str, dict[str, Any]] = {}
    for entry in sessions.values():
        if not isinstance(entry, dict):
            continue
        if str(entry.get("sessionId") or "").strip() != session_id:
            continue
        for tab in entry.get("tabs") if isinstance(entry.get("tabs"), list) else []:
            if not isinstance(tab, dict):
                continue
            task_id = str(tab.get("taskId") or "").strip()
            if task_id:
                tabs_by_id[task_id] = tab
    if not tabs_by_id:
        for tab in _task_segments_from_switch_state(session_id):
            task_id = str(tab.get("taskId") or "").strip()
            if task_id:
                tabs_by_id[task_id] = tab
    raw_tabs = list(tabs_by_id.values())
    tabs, enriched = _enrich_task_segment_tabs(session_id, raw_tabs)
    if enriched and tabs:
        directory = ""
        for entry in sessions.values():
            if isinstance(entry, dict) and str(entry.get("sessionId") or "").strip() == session_id:
                directory = str(entry.get("directory") or "").strip()
                break
        _persist_task_segments_index_tabs(session_id, directory or None, tabs)
    return {"ok": True, "sessionId": session_id, "count": len(tabs), "tabs": tabs}


def _load_task_skill_index() -> dict[str, Any]:
    if not TASK_SKILL_INDEX_PATH.exists():
        return {"tasks": {}}
    try:
        data = json.loads(TASK_SKILL_INDEX_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("tasks"), dict):
            return data
    except Exception:
        pass
    return {"tasks": {}}


def _save_task_skill_index(data: dict[str, Any]) -> None:
    data["updatedAt"] = now_iso()
    write_json(TASK_SKILL_INDEX_PATH, data)


def _task_skill_key(session_id: str, task_id: str) -> str:
    return f"{session_id}::{task_id}"


def _skill_records_from_pipeline_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for item in result.get("writerResults") or []:
        if not isinstance(item, dict):
            continue
        suggestion = item.get("suggestion") if isinstance(item.get("suggestion"), dict) else {}
        writer = item.get("result") if isinstance(item.get("result"), dict) else {}
        skill_name = str(writer.get("skillName") or suggestion.get("skill_name") or "").strip()
        target_dir = str(writer.get("targetDir") or "").strip()
        if not target_dir:
            removed = writer.get("removedPaths")
            if isinstance(removed, list) and removed:
                target_dir = str(removed[0] or "").strip()
        status = str(writer.get("status") or "").strip() or "unknown"
        if not skill_name and not target_dir:
            continue
        records.append(
            {
                "skillName": skill_name,
                "skillPath": target_dir,
                "status": "ready" if status == "ok" else status,
                "operation": str(writer.get("operation") or suggestion.get("operation") or ""),
                "rationale": str(suggestion.get("rationale") or ""),
                "createdAt": now_iso(),
                "engine": str(writer.get("engine") or result.get("engine") or suggestion.get("engine") or ""),
            }
        )
    return records


def _enrich_skill_provenance(
    skill_dir: Path,
    *,
    session_id: str,
    task_id: str,
    task_segment: dict[str, Any] | None = None,
    source: str = "pipeline",
    pipeline_run_dir: str = "",
) -> None:
    """Write sessionId/taskId into skill folder so disk scan can rebuild the index later."""
    if not skill_dir.exists() or not skill_dir.is_dir():
        return
    provenance_path = skill_dir / "PROVENANCE.json"
    existing = _safe_read_json_file(provenance_path)
    payload: dict[str, Any] = existing if isinstance(existing, dict) else {}
    payload.update(
        {
            "sessionId": session_id,
            "taskId": task_id,
            "taskSegment": task_segment or payload.get("taskSegment") or {},
            "source": payload.get("source") or source,
        }
    )
    if pipeline_run_dir:
        payload["pipelineRunDir"] = pipeline_run_dir
    write_json(provenance_path, payload)


def _normalize_skill_path_marker(path: str) -> str:
    raw = str(path or "").strip()
    if not raw:
        return ""
    try:
        return str(Path(raw).expanduser().resolve()).lower()
    except Exception:
        return raw.lower()


def _load_skill_history_index() -> dict[str, Any]:
    if not SKILL_HISTORY_INDEX_PATH.exists():
        return {"skills": {}}
    try:
        data = json.loads(SKILL_HISTORY_INDEX_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {"skills": {}}
    except Exception:
        return {"skills": {}}


def _save_skill_history_index(data: dict[str, Any]) -> None:
    SKILL_HISTORY_INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    SKILL_HISTORY_INDEX_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _truncate_text(value: Any, max_len: int = 240) -> str:
    text = str(value or "").strip()
    if len(text) <= max_len:
        return text
    return f"{text[: max_len - 1].rstrip()}…"


def _summarize_file_guidance(file_guidance: Any) -> list[dict[str, str]]:
    if not isinstance(file_guidance, list):
        return []
    rows: list[dict[str, str]] = []
    for item in file_guidance:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or item.get("relative_path") or "SKILL.md").strip()
        operation = str(item.get("operation") or item.get("action") or "UPDATE").upper()
        reason = str(item.get("reason") or "").strip()
        guidance = item.get("guidance")
        summary = ""
        if isinstance(guidance, dict):
            parts = [
                str(guidance.get("section_capability") or "").strip(),
                str(guidance.get("description") or "").strip(),
            ]
            summary = " · ".join(part for part in parts if part)
        elif isinstance(guidance, str):
            summary = guidance.strip()
        rows.append(
            {
                "path": path,
                "operation": operation,
                "reason": reason,
                "summary": _truncate_text(summary, 180),
            }
        )
    return rows


def _one_line_change_summary(*, operation: str, rationale: str, changes: list[dict[str, str]]) -> str:
    op = str(operation or "UPDATE").upper()
    if op == "CREATE":
        lead = "Create skill"
    elif op == "DELETE":
        lead = "Delete skill"
    elif op == "NONE":
        lead = "No changes needed"
    elif op == "MANUAL_EDIT":
        lead = "Manual SKILL.md edit"
    else:
        lead = "Update skill"
    if changes:
        first = changes[0]
        path = str(first.get("path") or "SKILL.md")
        detail = str(first.get("summary") or first.get("reason") or rationale or "").strip()
        if detail:
            return _truncate_text(f"{lead} · {path} · {detail}", 280)
        return _truncate_text(f"{lead} · {path}", 280)
    if rationale:
        return _truncate_text(f"{lead} · {rationale}", 280)
    return lead


def _history_entry_from_pipeline_suggestion(
    suggestion: dict[str, Any],
    *,
    session_id: str,
    task_id: str,
    task_segment: dict[str, Any] | None,
    run_dir: str,
    created_at: str,
) -> dict[str, Any]:
    operation = str(suggestion.get("operation") or "UPDATE").upper()
    rationale = str(suggestion.get("rationale") or "").strip()
    changes = _summarize_file_guidance(suggestion.get("file_guidance"))
    trace_anchors = suggestion.get("trace_anchors") if isinstance(suggestion.get("trace_anchors"), list) else []
    task_label = ""
    if isinstance(task_segment, dict):
        task_label = str(task_segment.get("summary") or task_segment.get("title") or task_segment.get("description") or "").strip()
    return {
        "id": f"pipeline:{run_dir}:{created_at}",
        "source": "skill_evolve" if str(suggestion.get("engine") or "") == "skill_evolve" else "pipeline",
        "channel": "task_switch",
        "operation": operation,
        "rationale": rationale,
        "summary": _one_line_change_summary(operation=operation, rationale=rationale, changes=changes),
        "changes": changes,
        "traceAnchors": trace_anchors,
        "createdAt": created_at,
        "sessionId": session_id,
        "taskId": task_id,
        "taskLabel": task_label,
        "runDir": run_dir,
        "skillName": str(suggestion.get("skill_name") or "").strip(),
        "engine": str(suggestion.get("engine") or ""),
    }


def _history_entry_from_feedback_analysis(
    analysis: dict[str, Any],
    *,
    session_id: str,
    task_id: str,
    task_segment: dict[str, Any] | None,
    run_dir: str,
    created_at: str,
    user_comment: str = "",
    feedback_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    operation = str(analysis.get("operation") or "CREATE").upper()
    rationale = str(analysis.get("rationale") or user_comment or "").strip()
    trace_anchors = analysis.get("trace_anchors") if isinstance(analysis.get("trace_anchors"), list) else []
    task_label = ""
    if isinstance(feedback_context, dict):
        task_label = str(feedback_context.get("taskLabel") or "").strip()
    if not task_label and isinstance(task_segment, dict):
        task_label = str(task_segment.get("summary") or task_segment.get("title") or "").strip()
    steps = [str(item).strip() for item in (analysis.get("steps") or []) if str(item).strip()]
    changes = [{"path": "SKILL.md", "operation": operation, "reason": rationale, "summary": _truncate_text(steps[0], 180) if steps else ""}]
    return {
        "id": f"feedback:{run_dir}:{created_at}",
        "source": "feedback_distill",
        "channel": "feedback",
        "operation": operation,
        "rationale": rationale,
        "summary": _one_line_change_summary(operation=operation, rationale=rationale, changes=changes),
        "changes": changes,
        "traceAnchors": trace_anchors,
        "createdAt": created_at,
        "sessionId": session_id,
        "taskId": task_id,
        "taskLabel": task_label,
        "runDir": run_dir,
        "userComment": user_comment,
        "feedbackContext": feedback_context or {},
        "skillName": str(analysis.get("skill_name") or "").strip(),
    }


def append_skill_history_entry(skill_path: str, entry: dict[str, Any]) -> None:
    marker = _normalize_skill_path_marker(skill_path)
    if not marker:
        return
    with _task_switch_lock:
        index = _load_skill_history_index()
        skills = index.setdefault("skills", {})
        bucket = skills.setdefault(
            marker,
            {
                "skillPath": str(entry.get("skillPath") or skill_path),
                "skillName": str(entry.get("skillName") or Path(skill_path).name),
                "entries": [],
            },
        )
        entries = [x for x in bucket.get("entries", []) if isinstance(x, dict)]
        entry_id = str(entry.get("id") or uuid4().hex)
        if any(str(x.get("id") or "") == entry_id for x in entries):
            return
        payload = {**entry, "id": entry_id}
        entries.append(payload)
        entries.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
        bucket["entries"] = entries[:80]
        bucket["skillPath"] = str(entry.get("skillPath") or skill_path)
        if entry.get("skillName"):
            bucket["skillName"] = str(entry.get("skillName"))
        _save_skill_history_index(index)


def _pipeline_suggestion_for_skill(run_dir_raw: str, skill_name: str) -> dict[str, Any] | None:
    if not run_dir_raw:
        return None
    suggestions_path = Path(run_dir_raw) / "05-skill-suggestions.json"
    payload = _safe_read_json_file(suggestions_path)
    if not isinstance(payload, dict):
        return None
    suggestions = payload.get("skill_suggestions")
    if not isinstance(suggestions, list):
        return None
    normalized_name = str(skill_name or "").strip().lower()
    for item in suggestions:
        if not isinstance(item, dict):
            continue
        candidate = str(item.get("skill_name") or "").strip().lower()
        if normalized_name and candidate == normalized_name:
            return item
    return suggestions[0] if suggestions and isinstance(suggestions[0], dict) else None


def _synthesize_history_from_skill_record(skill: dict[str, Any], task: dict[str, Any]) -> dict[str, Any]:
    session_id = str(task.get("sessionId") or "").strip()
    task_id = str(task.get("taskId") or "").strip()
    task_segment = task.get("taskSegment") if isinstance(task.get("taskSegment"), dict) else {}
    created_at = str(skill.get("createdAt") or task.get("updatedAt") or now_iso())
    skill_path = str(skill.get("skillPath") or "")
    skill_name = str(skill.get("skillName") or Path(skill_path).name if skill_path else "")
    feedback_run_dir = str(skill.get("feedbackRunDir") or "").strip()
    if feedback_run_dir:
        analysis = _safe_read_json_file(Path(feedback_run_dir) / "04-feedback-analysis.json")
        request = _safe_read_json_file(Path(feedback_run_dir) / "01-request.json")
        comment = ""
        feedback_context: dict[str, Any] = {}
        if isinstance(request, dict):
            comment = str(request.get("comment") or "").strip()
            feedback_context = request.get("feedbackContext") if isinstance(request.get("feedbackContext"), dict) else {}
        if isinstance(analysis, dict):
            entry = _history_entry_from_feedback_analysis(
                analysis,
                session_id=session_id,
                task_id=task_id,
                task_segment=task_segment,
                run_dir=feedback_run_dir,
                created_at=created_at,
                user_comment=comment,
                feedback_context=feedback_context,
            )
            entry["skillPath"] = skill_path
            entry["skillName"] = skill_name
            return entry
    pipeline_run_dir = str(task.get("pipelineRunDir") or "").strip()
    suggestion = _pipeline_suggestion_for_skill(pipeline_run_dir, skill_name)
    if isinstance(suggestion, dict):
        entry = _history_entry_from_pipeline_suggestion(
            suggestion,
            session_id=session_id,
            task_id=task_id,
            task_segment=task_segment,
            run_dir=pipeline_run_dir,
            created_at=created_at,
        )
        entry["skillPath"] = skill_path
        entry["skillName"] = skill_name
        if not entry.get("rationale"):
            entry["rationale"] = str(skill.get("rationale") or "")
        if not entry.get("summary") or entry.get("summary") == "Update skill":
            entry["summary"] = _one_line_change_summary(
                operation=str(entry.get("operation") or skill.get("operation") or "UPDATE"),
                rationale=str(entry.get("rationale") or ""),
                changes=entry.get("changes") if isinstance(entry.get("changes"), list) else [],
            )
        return entry
    operation = str(skill.get("operation") or "UPDATE").upper()
    rationale = str(skill.get("rationale") or "").strip()
    return {
        "id": f"task-record:{session_id}:{task_id}:{created_at}",
        "source": "pipeline" if not feedback_run_dir else "feedback_distill",
        "channel": "feedback" if feedback_run_dir else "task_switch",
        "operation": operation,
        "rationale": rationale,
        "summary": _one_line_change_summary(operation=operation, rationale=rationale, changes=[]),
        "changes": [],
        "traceAnchors": [],
        "createdAt": created_at,
        "sessionId": session_id,
        "taskId": task_id,
        "taskLabel": str(task_segment.get("summary") or task_segment.get("title") or "").strip(),
        "runDir": feedback_run_dir or pipeline_run_dir,
        "skillPath": skill_path,
        "skillName": skill_name,
    }


def collect_skill_distill_history(skill_path: str) -> list[dict[str, Any]]:
    marker = _normalize_skill_path_marker(skill_path)
    if not marker:
        return []
    entries: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    history_index = _load_skill_history_index()
    bucket = (history_index.get("skills") or {}).get(marker)
    if isinstance(bucket, dict):
        for item in bucket.get("entries", []):
            if not isinstance(item, dict):
                continue
            entry_id = str(item.get("id") or "")
            if entry_id:
                seen_ids.add(entry_id)
            entries.append(item)

    task_index = _load_task_skill_index()
    for task in (task_index.get("tasks") or {}).values():
        if not isinstance(task, dict):
            continue
        for skill in task.get("skills", []):
            if not isinstance(skill, dict):
                continue
            if _normalize_skill_path_marker(str(skill.get("skillPath") or "")) != marker:
                continue
            synthesized = _synthesize_history_from_skill_record(skill, task)
            entry_id = str(synthesized.get("id") or "")
            if entry_id and entry_id in seen_ids:
                continue
            if entry_id:
                seen_ids.add(entry_id)
            entries.append(synthesized)

    entries.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
    return entries


def _skill_path_is_writable(skill_dir: Path) -> bool:
    try:
        resolved = skill_dir.expanduser().resolve()
    except Exception:
        return False
    for root in configured_skill_roots(Path(OPENCODE_DIRECTORY)):
        try:
            root_resolved = root.expanduser().resolve()
            resolved.relative_to(root_resolved)
            return True
        except Exception:
            continue
    return False


def save_task_skill_md(payload: dict[str, Any]) -> dict[str, Any]:
    skill_path_raw = str(payload.get("skillPath") or payload.get("skillKey") or "").strip()
    content = payload.get("content")
    session_id = str(payload.get("sessionId") or "").strip()
    task_id = str(payload.get("taskId") or "").strip()
    if not skill_path_raw:
        return {"ok": False, "error": "skillPath is required"}
    if not isinstance(content, str):
        return {"ok": False, "error": "content must be a string"}

    skill_dir = Path(skill_path_raw)
    if not skill_dir.exists() or not skill_dir.is_dir():
        return {"ok": False, "error": f"skill directory not found: {skill_dir}"}
    if not _skill_path_is_writable(skill_dir):
        return {"ok": False, "error": "skill path is outside configured skill roots"}

    skill_md_path = skill_dir / "SKILL.md"
    skill_md_path.write_text(content, encoding="utf-8")
    created_at = now_iso()
    skill_name = skill_dir.name
    try:
        parsed_name, _desc = extract_skill_fields(content, skill_dir.name)
        if parsed_name:
            skill_name = parsed_name
    except Exception:
        pass

    entry = {
        "id": f"manual:{created_at}:{uuid4().hex[:8]}",
        "source": "manual_edit",
        "channel": "manual",
        "operation": "MANUAL_EDIT",
        "rationale": "User directly edited and saved SKILL.md in the Skill Panel.",
        "summary": "Manual SKILL.md edit",
        "changes": [{"path": "SKILL.md", "operation": "UPDATE", "reason": "manual edit", "summary": ""}],
        "traceAnchors": [],
        "createdAt": created_at,
        "sessionId": session_id,
        "taskId": task_id,
        "runDir": "",
        "skillPath": str(skill_dir.resolve()),
        "skillName": skill_name,
    }
    append_skill_history_entry(str(skill_dir.resolve()), entry)

    return {
        "ok": True,
        "skillMd": content,
        "skillMdPath": str(skill_md_path),
        "skillName": skill_name,
        "historyEntry": entry,
    }


def mark_task_skill_status(
    session_id: str,
    task_segment: dict[str, Any],
    *,
    status: str,
    pipeline_run_dir: str = "",
    error: str = "",
) -> None:
    """Mark a task skill index entry (e.g. distilling) so the Skill Panel can poll."""
    task_id = str(task_segment.get("taskId") or "").strip()
    if not session_id or not task_id:
        return
    with _task_switch_lock:
        index = _load_task_skill_index()
        tasks = index.setdefault("tasks", {})
        key = _task_skill_key(session_id, task_id)
        existing = tasks.get(key) if isinstance(tasks.get(key), dict) else {}
        skills = [x for x in existing.get("skills", []) if isinstance(x, dict)]
        entry: dict[str, Any] = {
            **existing,
            "sessionId": session_id,
            "taskId": task_id,
            "taskSegment": task_segment or existing.get("taskSegment") or {},
            "status": status,
            "skills": skills,
            "updatedAt": now_iso(),
        }
        if pipeline_run_dir:
            entry["pipelineRunDir"] = pipeline_run_dir
        if error:
            entry["error"] = error
        elif "error" in entry and status in {"distilling", "ready", "none"}:
            entry.pop("error", None)
        tasks[key] = entry
        _save_task_skill_index(index)


def register_task_skill_result(
    session_id: str,
    task_segment: dict[str, Any],
    pipeline_result: dict[str, Any],
) -> None:
    task_id = str(task_segment.get("taskId") or "").strip()
    if not session_id or not task_id:
        return
    skills = _skill_records_from_pipeline_result(pipeline_result)
    pipeline_run_dir = str(pipeline_result.get("runDir") or "")
    writer_results = pipeline_result.get("writerResults")
    suggestions_by_index: dict[int, dict[str, Any]] = {}
    if isinstance(writer_results, list):
        for item in writer_results:
            if not isinstance(item, dict):
                continue
            idx = int(item.get("index") or 0)
            suggestion = item.get("suggestion")
            if isinstance(suggestion, dict):
                suggestions_by_index[idx] = suggestion
    suggestions_payload = _safe_read_json_file(Path(pipeline_run_dir) / "05-skill-suggestions.json") if pipeline_run_dir else None
    suggestions_list: list[dict[str, Any]] = []
    if isinstance(suggestions_payload, dict) and isinstance(suggestions_payload.get("skill_suggestions"), list):
        suggestions_list = [x for x in suggestions_payload.get("skill_suggestions") if isinstance(x, dict)]

    for skill in skills:
        skill_path = str(skill.get("skillPath") or "").strip()
        if skill_path:
            _enrich_skill_provenance(
                Path(skill_path),
                session_id=session_id,
                task_id=task_id,
                task_segment=task_segment,
                source="pipeline",
                pipeline_run_dir=pipeline_run_dir,
            )
        skill_name = str(skill.get("skillName") or "").strip()
        suggestion = _pipeline_suggestion_for_skill(pipeline_run_dir, skill_name)
        if not isinstance(suggestion, dict) and suggestions_list:
            suggestion = suggestions_list[0]
        if isinstance(suggestion, dict):
            created_at = str(skill.get("createdAt") or now_iso())
            history_entry = _history_entry_from_pipeline_suggestion(
                suggestion,
                session_id=session_id,
                task_id=task_id,
                task_segment=task_segment,
                run_dir=pipeline_run_dir,
                created_at=created_at,
            )
            history_entry["skillPath"] = skill_path
            history_entry["skillName"] = skill_name
            append_skill_history_entry(skill_path, history_entry)

    with _task_switch_lock:
        index = _load_task_skill_index()
        tasks = index.setdefault("tasks", {})
        key = _task_skill_key(session_id, task_id)
        existing = tasks.get(key) if isinstance(tasks.get(key), dict) else {}
        merged_skills = [x for x in existing.get("skills", []) if isinstance(x, dict)]
        by_marker: dict[str, dict[str, Any]] = {}
        for item in merged_skills:
            marker = _normalize_skill_path_marker(str(item.get("skillPath") or item.get("skillName") or ""))
            if marker:
                by_marker[marker] = item
        for skill in skills:
            marker = _normalize_skill_path_marker(str(skill.get("skillPath") or skill.get("skillName") or ""))
            if marker:
                by_marker[marker] = {**by_marker.get(marker, {}), **skill}
            else:
                merged_skills.append(skill)
        merged_skills = list(by_marker.values()) if by_marker else merged_skills
        tasks[key] = {
            **existing,
            "sessionId": session_id,
            "taskId": task_id,
            "taskSegment": task_segment,
            "status": "ready" if merged_skills else "none",
            "skills": merged_skills,
            "pipelineRunDir": pipeline_result.get("runDir"),
            "updatedAt": now_iso(),
        }
        _save_task_skill_index(index)


def merge_task_skill_records(
    session_id: str,
    task_id: str,
    skills: list[dict[str, Any]],
    *,
    task_segment: dict[str, Any] | None,
    source: str,
) -> None:
    if not session_id or not task_id or not skills:
        return
    with _task_switch_lock:
        index = _load_task_skill_index()
        tasks = index.setdefault("tasks", {})
        key = _task_skill_key(session_id, task_id)
        existing = tasks.get(key) if isinstance(tasks.get(key), dict) else {}
        merged_skills = [x for x in existing.get("skills", []) if isinstance(x, dict)]
        seen = {str(x.get("skillPath") or x.get("skillName") or "") for x in merged_skills}
        changed = False
        for skill in skills:
            marker = str(skill.get("skillPath") or skill.get("skillName") or "")
            if marker and marker in seen:
                continue
            if marker:
                seen.add(marker)
            merged_skills.append(skill)
            changed = True
        if not changed and isinstance(existing, dict):
            return
        tasks[key] = {
            **existing,
            "sessionId": session_id,
            "taskId": task_id,
            "taskSegment": task_segment or existing.get("taskSegment") or {},
            "status": "ready" if merged_skills else "none",
            "skills": merged_skills,
            "source": source,
            "updatedAt": now_iso(),
        }
        _save_task_skill_index(index)


def configured_skill_roots(project_dir: Path | None) -> list[Path]:
    if SKILL_LOAD_ROOTS:
        roots = [*SKILL_LOAD_ROOTS]
    else:
        effective_project_dir = project_dir or Path(OPENCODE_DIRECTORY)
        roots = [
            effective_project_dir / ".opencode" / "skills",
            Path.home() / ".config" / "opencode" / "skills",
            effective_project_dir / ".claude" / "skills",
            Path.home() / ".claude" / "skills",
            effective_project_dir / ".agents" / "skills",
            Path.home() / ".agents" / "skills",
            SKILL_WRITE_ROOT,
        ]
    roots.extend(SKILL_SEARCH_ROOTS_EXTRA)

    unique: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        try:
            resolved = root.expanduser().resolve()
        except Exception:
            resolved = root.expanduser()
        marker = str(resolved).lower()
        if marker in seen:
            continue
        seen.add(marker)
        unique.append(resolved)
    return unique


def _provenance_matches_task(provenance: dict[str, Any], session_id: str, task_id: str) -> bool:
    session_id = str(session_id or "").strip()
    task_id = str(task_id or "").strip()
    if not session_id or not task_id:
        return False
    if str(provenance.get("sessionId") or "").strip() == session_id and str(provenance.get("taskId") or "").strip() == task_id:
        return True
    aliases = provenance.get("forkAliases")
    if not isinstance(aliases, list):
        return False
    for alias in aliases:
        if not isinstance(alias, dict):
            continue
        if str(alias.get("sessionId") or "").strip() == session_id and str(alias.get("taskId") or "").strip() == task_id:
            return True
    return False


def _append_fork_skill_alias(
    skill_dir: Path,
    *,
    fork_session_id: str,
    fork_task_id: str,
    source_session_id: str,
    source_task_id: str,
) -> None:
    if not skill_dir.exists() or not skill_dir.is_dir():
        return
    provenance_path = skill_dir / "PROVENANCE.json"
    existing = _safe_read_json_file(provenance_path)
    payload: dict[str, Any] = existing if isinstance(existing, dict) else {}
    aliases = payload.get("forkAliases")
    if not isinstance(aliases, list):
        aliases = []
    already = any(
        isinstance(item, dict)
        and str(item.get("sessionId") or "").strip() == fork_session_id
        and str(item.get("taskId") or "").strip() == fork_task_id
        for item in aliases
    )
    if not already:
        aliases.append(
            {
                "sessionId": fork_session_id,
                "taskId": fork_task_id,
                "sourceSessionId": source_session_id,
                "sourceTaskId": source_task_id,
            }
        )
    payload["forkAliases"] = aliases
    write_json(provenance_path, payload)


def _merge_skill_record_lists(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for group in groups:
        for skill in group:
            if not isinstance(skill, dict):
                continue
            marker = _normalize_skill_path_marker(str(skill.get("skillPath") or skill.get("skillName") or ""))
            if marker and marker in seen:
                continue
            if marker:
                seen.add(marker)
            merged.append(skill)
    return merged


def _collect_skills_for_session_task(
    session_id: str,
    task_id: str,
    directory: str | None,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    session_id = str(session_id or "").strip()
    task_id = str(task_id or "").strip()
    if not session_id or not task_id:
        return [], None
    index = _load_task_skill_index()
    key = _task_skill_key(session_id, task_id)
    entry = (index.get("tasks") or {}).get(key)
    index_skills = [x for x in entry.get("skills", []) if isinstance(x, dict)] if isinstance(entry, dict) else []
    discovered = discover_task_skills_from_disk(session_id, task_id, directory)
    skills = _merge_skill_record_lists(index_skills, discovered)
    return skills, entry if isinstance(entry, dict) else None


def _fork_skill_source_from_segments_index(
    session_id: str,
    task_id: str,
    directory: str | None,
) -> tuple[str, str, str] | None:
    session_id = str(session_id or "").strip()
    task_id = str(task_id or "").strip()
    if not session_id or not task_id:
        return None
    session_key = _task_switch_session_key(session_id, directory)
    index = _load_task_segments_index()
    sessions = index.get("sessions") if isinstance(index.get("sessions"), dict) else {}
    entry = sessions.get(session_key)
    if not isinstance(entry, dict):
        return None
    source_parent = str(entry.get("forkSourceParentSessionId") or "").strip()
    for tab in entry.get("tabs") if isinstance(entry.get("tabs"), list) else []:
        if not isinstance(tab, dict):
            continue
        if str(tab.get("taskId") or "").strip() != task_id:
            continue
        source_task_id = str(tab.get("sourceTaskId") or tab.get("taskId") or "").strip()
        source_parent = source_parent or str(tab.get("sourceParentSessionId") or "").strip()
        if source_parent and source_task_id:
            return source_parent, source_task_id, task_id
    return None


def _materialize_fork_skills_if_missing(
    session_id: str,
    task_id: str,
    directory: str | None,
) -> int:
    existing, _entry = _collect_skills_for_session_task(session_id, task_id, directory)
    if existing:
        return len(existing)
    source = _fork_skill_source_from_segments_index(session_id, task_id, directory)
    if not source:
        return 0
    source_parent, source_task_id, fork_task_id = source
    return _copy_task_skill_index_for_fork(
        source_session_id=source_parent,
        fork_session_id=session_id,
        inherited_tabs=[
            {
                "taskId": fork_task_id,
                "sourceTaskId": source_task_id,
            }
        ],
        directory_override=directory,
    )


def discover_task_skills_from_disk(session_id: str, task_id: str, directory: str | None) -> list[dict[str, Any]]:
    project_dir = resolve_config_path(directory, Path(OPENCODE_DIRECTORY)) if directory else Path(OPENCODE_DIRECTORY)
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for root in configured_skill_roots(project_dir):
        if not root.exists() or not root.is_dir():
            continue
        for child in root.iterdir():
            if not child.is_dir():
                continue
            provenance_path = child / "PROVENANCE.json"
            provenance = _safe_read_json_file(provenance_path)
            if not isinstance(provenance, dict):
                continue
            if not _provenance_matches_task(provenance, session_id, task_id):
                continue

            skill_md_path = child / "SKILL.md"
            skill_name = str(provenance.get("skillName") or child.name).strip()
            rationale = str(provenance.get("rationale") or "").strip()
            try:
                if skill_md_path.exists():
                    parsed_name, desc = extract_skill_fields(skill_md_path.read_text(encoding="utf-8"), child.name)
                    skill_name = skill_name or parsed_name
                    rationale = rationale or desc
            except Exception:
                pass
            marker = str(child.resolve())
            if marker in seen:
                continue
            seen.add(marker)
            records.append(
                {
                    "skillName": skill_name or child.name,
                    "skillPath": marker,
                    "status": "ready",
                    "operation": str(provenance.get("operation") or provenance.get("source") or "PROVENANCE").strip(),
                    "rationale": rationale,
                    "createdAt": str(provenance.get("generatedAt") or ""),
                    "feedbackRunDir": str(provenance.get("runDir") or "") if provenance.get("source") == "feedback_distill" else "",
                    "source": "provenance_scan",
                }
            )
    return records


def task_skills_response(session_id: str, task_id: str) -> dict[str, Any]:
    return task_skills_response_for_directory(session_id, task_id, None)


def task_skills_response_for_directory(session_id: str, task_id: str, directory: str | None) -> dict[str, Any]:
    _materialize_fork_skills_if_missing(session_id, task_id, directory)
    discovered = discover_task_skills_from_disk(session_id, task_id, directory)
    if discovered:
        merge_task_skill_records(
            session_id,
            task_id,
            discovered,
            task_segment=None,
            source="provenance_scan",
        )
    skills, task = _collect_skills_for_session_task(session_id, task_id, directory)
    if skills and not isinstance(task, dict):
        merge_task_skill_records(
            session_id,
            task_id,
            skills,
            task_segment=None,
            source="fork_inherit",
        )
        skills, task = _collect_skills_for_session_task(session_id, task_id, directory)
    if not isinstance(task, dict):
        return {
            "ok": True,
            "sessionId": session_id,
            "taskId": task_id,
            "status": "none",
            "skills": skills,
            "skillWriteRoot": str(SKILL_WRITE_ROOT),
            "discoveredCount": len(discovered),
        }
    resolved_skills = skills if skills else ([x for x in task.get("skills", []) if isinstance(x, dict)])
    return {
        "ok": True,
        "sessionId": session_id,
        "taskId": task_id,
        "status": task.get("status") or ("ready" if resolved_skills else "none"),
        "skills": resolved_skills,
        "taskSegment": task.get("taskSegment") or {},
        "pipelineRunDir": task.get("pipelineRunDir") or "",
        "updatedAt": task.get("updatedAt") or "",
        "skillWriteRoot": str(SKILL_WRITE_ROOT),
        "discoveredCount": len(discovered),
    }


def _safe_read_json_file(path: Path) -> Any:
    if not path.exists() or not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return {"_error": str(e), "_path": str(path)}


def task_skill_detail_response(session_id: str, task_id: str, skill_key: str) -> dict[str, Any]:
    _materialize_fork_skills_if_missing(session_id, task_id, None)
    index = _load_task_skill_index()
    task = (index.get("tasks") or {}).get(_task_skill_key(session_id, task_id))
    if not isinstance(task, dict):
        return {"ok": False, "error": "task skill record not found"}

    skills = [item for item in task.get("skills", []) if isinstance(item, dict)]
    skill = next(
        (
            item
            for item in skills
            if skill_key
            and skill_key
            in {
                str(item.get("skillPath") or ""),
                str(item.get("skillName") or ""),
                str(item.get("feedbackRunDir") or ""),
            }
        ),
        None,
    )
    if not isinstance(skill, dict):
        return {"ok": False, "error": "skill record not found"}

    skill_dir = Path(str(skill.get("skillPath") or ""))
    skill_md_path = skill_dir / "SKILL.md"
    skill_md = ""
    skill_read_error = ""
    try:
        if skill_md_path.exists() and skill_md_path.is_file():
            skill_md = skill_md_path.read_text(encoding="utf-8")
        else:
            skill_read_error = f"SKILL.md not found at {skill_md_path}"
    except Exception as e:
        skill_read_error = str(e)

    provenance = _safe_read_json_file(skill_dir / "PROVENANCE.json")

    feedback_run_dir_raw = str(skill.get("feedbackRunDir") or "").strip()
    feedback_run_dir = Path(feedback_run_dir_raw) if feedback_run_dir_raw else None
    feedback_detail: dict[str, Any] = {}
    try:
        if feedback_run_dir is not None:
            resolved = feedback_run_dir.resolve()
            resolved.relative_to(LOG_ROOT.resolve())
            feedback_detail = {
                "runDir": str(feedback_run_dir),
                "request": _safe_read_json_file(feedback_run_dir / "01-request.json"),
                "analysis": _safe_read_json_file(feedback_run_dir / "04-feedback-analysis.json"),
                "result": _safe_read_json_file(feedback_run_dir / "05-result.json")
                or _safe_read_json_file(feedback_run_dir / "03-result.json"),
            }
    except Exception as e:
        feedback_detail = {"runDir": feedback_run_dir_raw, "error": str(e)}

    return {
        "ok": True,
        "sessionId": session_id,
        "taskId": task_id,
        "skill": skill,
        "skillMd": skill_md,
        "skillMdPath": str(skill_md_path),
        "skillReadError": skill_read_error,
        "provenance": provenance,
        "feedback": feedback_detail,
        "history": collect_skill_distill_history(str(skill_dir.resolve() if skill_dir.exists() else skill.get("skillPath") or "")),
    }


def feedback_distill_run_dir(session_id: str, task_id: str) -> Path:
    stamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S-%f")
    return LOG_ROOT / f"{stamp}-{_safe_id(session_id) or 'unknown-session'}-{_safe_id(task_id) or 'unknown-task'}-feedback-distill-{uuid4().hex[:8]}"


def distill_feedback_skill(payload: dict[str, Any]) -> dict[str, Any]:
    session_id = str(payload.get("sessionId") or "").strip()
    task_id = str(payload.get("taskId") or "").strip()
    directory = str(payload.get("directory") or "").strip() or OPENCODE_DIRECTORY
    parent_session_id = str(payload.get("parentSessionID") or "").strip() or session_id
    comment = str(payload.get("comment") or "").strip()
    task_segment = payload.get("taskSegment") if isinstance(payload.get("taskSegment"), dict) else {}
    selected_anchor = payload.get("selectedAnchor") if isinstance(payload.get("selectedAnchor"), dict) else {}
    feedback_context = payload.get("feedbackContext") if isinstance(payload.get("feedbackContext"), dict) else {}
    if not session_id or not task_id:
        return {"ok": False, "error": "sessionId and taskId are required"}

    run_dir = feedback_distill_run_dir(session_id, task_id)
    run_dir.mkdir(parents=True, exist_ok=True)
    log_file = run_dir / "00-run.log"
    append_log(
        log_file,
        "feedback_distill.start",
        {"sessionId": session_id, "taskId": task_id, "directory": directory, "parentSessionID": parent_session_id},
    )
    write_json(run_dir / "01-request.json", payload)

    prompt_template = (PROMPT_ROOT / "feedback_distill_prompt.md").read_text(encoding="utf-8")
    prompt_input = {
        "sessionId": session_id,
        "taskId": task_id,
        "directory": directory,
        "taskSegment": task_segment,
        "selectedAnchor": selected_anchor,
        "overallComment": comment,
        "feedbackContext": feedback_context,
    }
    rendered_prompt = prompt_template.replace("{{FEEDBACK_DISTILL_INPUT_JSON}}", json.dumps(prompt_input, ensure_ascii=False, indent=2))
    (run_dir / "02-feedback-distill-prompt.txt").write_text(rendered_prompt, encoding="utf-8")

    try:
        llm_out = opencode_generate_text(
            rendered_prompt,
            run_dir,
            log_file,
            "02a-feedback-distiller",
            directory=directory,
            parent_session_id=parent_session_id,
            retry_with_new_session=True,
            max_attempts=MW_ANALYZER_SESSION_ATTEMPTS,
        )
    except Exception as e:
        append_log(log_file, "feedback_distill.llm.failed", {"error": str(e)})
        return {
            "ok": False,
            "runDir": str(run_dir),
            "error": f"feedback distiller failed: {e}",
        }

    write_json(run_dir / "03-feedback-distiller-raw.json", llm_out)
    parsed_any = try_parse_json_value(str(llm_out.get("rawText") or ""))
    if not isinstance(parsed_any, dict):
        append_log(log_file, "feedback_distill.parse.failed", {"message": "no valid JSON object"})
        return {
            "ok": False,
            "runDir": str(run_dir),
            "error": "Feedback distiller output parse failed",
            "distillerOutput": llm_out,
        }
    analysis = parsed_any
    write_json(run_dir / "04-feedback-analysis.json", analysis)

    operation = str(analysis.get("operation") or "CREATE").upper()
    if operation == "NONE":
        append_log(log_file, "feedback_distill.none", {"rationale": str(analysis.get("rationale") or "")})
        write_json(run_dir / "05-result.json", {"analysis": analysis, "skipped": True, "reason": "operation=NONE"})
        return {
            "ok": True,
            "runDir": str(run_dir),
            "status": "none",
            "analysis": analysis,
            "distillerSessionID": str(((llm_out.get("session") or {}).get("id") or "")),
            "skills": task_skills_response(session_id, task_id).get("skills", []),
        }

    def as_text_list(value: Any) -> list[str]:
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        if isinstance(value, str) and value.strip():
            return [value.strip()]
        return []

    raw_skill_name = str(analysis.get("skill_name") or "").strip()
    safe_skill = _safe_id(raw_skill_name or f"feedback-{task_id}")[:96] or f"feedback-skill-{uuid4().hex[:8]}"
    target_dir = SKILL_WRITE_ROOT / safe_skill
    target_dir.mkdir(parents=True, exist_ok=True)

    description = str(analysis.get("description") or "Skill distilled from user feedback on subtask traces.").strip()
    rationale = str(analysis.get("rationale") or comment or "").strip()
    triggers = as_text_list(analysis.get("trigger_conditions"))
    steps = as_text_list(analysis.get("steps"))
    constraints = as_text_list(analysis.get("constraints"))
    trace_anchors = analysis.get("trace_anchors") if isinstance(analysis.get("trace_anchors"), list) else []

    def bullet_lines(items: list[str], fallback: str = "none") -> str:
        return "\n".join(f"- {item}" for item in items) if items else fallback

    skill_md = (
        f"---\nname: {safe_skill}\n"
        f"description: {description}\n---\n\n"
        f"## Capability\n\n{description}\n\n"
        f"## Usage\n\n{bullet_lines(triggers, 'Use this skill when encountering similar task scenarios.')}\n\n"
        f"## Steps\n\n{bullet_lines(steps)}\n\n"
        f"## Cautions / constraints\n\n{bullet_lines(constraints)}\n"
    )
    skill_path = target_dir / "SKILL.md"
    skill_path.write_text(skill_md, encoding="utf-8")
    write_json(
        target_dir / "PROVENANCE.json",
        {
            "generatedAt": now_iso(),
            "source": "feedback_distill",
            "sessionId": session_id,
            "taskId": task_id,
            "runDir": str(run_dir),
            "taskSegment": task_segment,
            "selectedAnchor": selected_anchor,
            "feedbackContext": feedback_context,
            "analysis": analysis,
            "distillerSessionID": str(((llm_out.get("session") or {}).get("id") or "")),
        },
    )

    skill_record = {
        "skillName": safe_skill,
        "skillPath": str(target_dir),
        "status": "ready",
        "operation": f"FEEDBACK_DISTILL_{operation}",
        "rationale": rationale,
        "createdAt": now_iso(),
        "feedbackRunDir": str(run_dir),
        "distillerSessionID": str(((llm_out.get("session") or {}).get("id") or "")),
    }
    history_entry = _history_entry_from_feedback_analysis(
        analysis,
        session_id=session_id,
        task_id=task_id,
        task_segment=task_segment,
        run_dir=str(run_dir),
        created_at=str(skill_record["createdAt"]),
        user_comment=comment,
        feedback_context=feedback_context,
    )
    history_entry["skillPath"] = str(target_dir.resolve())
    history_entry["skillName"] = safe_skill
    append_skill_history_entry(str(target_dir.resolve()), history_entry)
    with _task_switch_lock:
        index = _load_task_skill_index()
        tasks = index.setdefault("tasks", {})
        key = _task_skill_key(session_id, task_id)
        existing = tasks.get(key) if isinstance(tasks.get(key), dict) else {}
        skills = [x for x in existing.get("skills", []) if isinstance(x, dict)]
        skills.append(skill_record)
        tasks[key] = {
            **existing,
            "sessionId": session_id,
            "taskId": task_id,
            "taskSegment": task_segment or existing.get("taskSegment") or {},
            "status": "ready",
            "skills": skills,
            "updatedAt": now_iso(),
        }
        _save_task_skill_index(index)
    write_json(run_dir / "05-result.json", {"skill": skill_record, "targetDir": str(target_dir), "analysis": analysis})
    append_log(
        log_file,
        "feedback_distill.done",
        {
            "skillName": safe_skill,
            "targetDir": str(target_dir),
            "distillerSessionID": str(((llm_out.get("session") or {}).get("id") or "")),
        },
    )
    return {
        "ok": True,
        "runDir": str(run_dir),
        "skill": skill_record,
        "skills": task_skills_response(session_id, task_id).get("skills", []),
        "analysis": analysis,
        "distillerSessionID": str(((llm_out.get("session") or {}).get("id") or "")),
    }


def _task_segment_summary(
    turns: list[dict[str, Any]],
    *,
    title: str | None = None,
    description: str | None = None,
    summary: str | None = None,
) -> dict[str, Any]:
    clean = _dedupe_turn_records(turns)
    if not clean:
        return {
            "taskId": "",
            "fromStartUserMessageId": "",
            "fromEndAssistantMessageId": "",
            "toEndAssistantMessageId": "",
            "turnCount": 0,
            "title": str(title or "").strip(),
            "description": str(description or "").strip(),
            "summary": summary or "",
        }
    first = clean[0]
    last = clean[-1]
    from_end = str(first.get("endAssistantMessageId") or "")
    to_end = str(last.get("endAssistantMessageId") or "")
    resolved_title = str(title or "").strip()
    resolved_description = str(description or "").strip()
    if not resolved_description and summary:
        resolved_description = str(summary).strip()
    resolved_summary = _format_task_display_label(title=resolved_title, description=resolved_description)
    if not resolved_summary:
        resolved_summary = _summarize_user_input(str(first.get("userInput") or ""))
    return {
        "taskId": f"task:{from_end}:{to_end}",
        "fromStartUserMessageId": str(first.get("startUserMessageId") or ""),
        "fromEndAssistantMessageId": from_end,
        "toEndAssistantMessageId": to_end,
        "turnCount": len(clean),
        "title": resolved_title,
        "description": resolved_description,
        "summary": resolved_summary,
    }


def _pending_task_segment_placeholder(
    turn: dict[str, Any],
    *,
    title: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    user_input = str(turn.get("userInput") or "")
    stable = hashlib.sha1(user_input.encode("utf-8", errors="ignore")).hexdigest()[:12]
    resolved_title = str(title or "").strip()
    resolved_description = str(description or "").strip()
    resolved_summary = _format_task_display_label(
        title=resolved_title,
        description=resolved_description,
    )
    if not resolved_summary:
        resolved_summary = _summarize_user_input(user_input)
    return {
        "taskId": f"task:pending:{stable}",
        "fromStartUserMessageId": "",
        "fromEndAssistantMessageId": "",
        "toEndAssistantMessageId": "",
        "turnCount": 0,
        "title": resolved_title,
        "description": resolved_description,
        "summary": resolved_summary,
        "provisional": True,
    }


def _load_ingest_dedup_index() -> dict[str, Any]:
    if not INGEST_DEDUP_INDEX.exists():
        return {}
    try:
        data = json.loads(INGEST_DEDUP_INDEX.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_ingest_dedup_index(data: dict[str, Any]) -> None:
    INGEST_DEDUP_INDEX.parent.mkdir(parents=True, exist_ok=True)
    INGEST_DEDUP_INDEX.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _parse_iso_utc(ts: str) -> datetime | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _ingest_entry_age_sec(entry: dict[str, Any], field: str) -> float | None:
    dt = _parse_iso_utc(str(entry.get(field) or ""))
    if dt is None:
        return None
    return (datetime.now(timezone.utc) - dt).total_seconds()


def _ingest_entry_is_stale_running(entry: dict[str, Any]) -> bool:
    if str(entry.get("status") or "") != "running":
        return False
    age = _ingest_entry_age_sec(entry, "startedAt")
    if age is None:
        return True
    return age > INGEST_DEDUP_STALE_RUNNING_SEC


def _ingest_entry_failed_blocks_reingest(entry: dict[str, Any]) -> bool:
    if str(entry.get("status") or "") != "failed":
        return False
    age = _ingest_entry_age_sec(entry, "finishedAt")
    if age is None:
        return True
    return age <= INGEST_DEDUP_FAILED_COOLDOWN_SEC


def _pipeline_result_from_run_dir(run_dir: Path, *, duplicate: bool = False, dedup_key: str = "") -> dict[str, Any]:
    summary: dict[str, Any] = {}
    summary_path = run_dir / "00-summary.json"
    if summary_path.exists():
        try:
            loaded = json.loads(summary_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                summary = loaded
        except Exception:
            pass
    analyzer_output: dict[str, Any] = {}
    analysis: dict[str, Any] | None = None
    analyzer_path = run_dir / "04-analyzer-raw.json"
    if analyzer_path.exists():
        try:
            loaded = json.loads(analyzer_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                analyzer_output = loaded
                parsed = loaded.get("analysis")
                analysis = parsed if isinstance(parsed, dict) else None
        except Exception:
            pass
    writer_results: list[dict[str, Any]] = []
    writer_path = run_dir / "07-writer-result.json"
    if writer_path.exists():
        try:
            loaded = json.loads(writer_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict) and isinstance(loaded.get("results"), list):
                writer_results = [x for x in loaded["results"] if isinstance(x, dict)]
        except Exception:
            pass
    out: dict[str, Any] = {
        "ok": True,
        "runId": str(summary.get("runId") or run_dir.name),
        "runDir": str(run_dir),
        "tracePath": str(run_dir / "01-trace.json"),
        "poolSummaryPath": str(run_dir / "02-pool-summary.json"),
        "suggestionsPath": str(run_dir / "05-skill-suggestions.json"),
        "writerResultPath": str(run_dir / "07-writer-result.json"),
        "analyzerOutput": analyzer_output,
        "analysis": analysis,
        "writerResults": writer_results,
        "analyzerSessionID": str(summary.get("analyzerSessionID") or ""),
        "writerSessionID": str(summary.get("writerSessionID") or ""),
    }
    if duplicate:
        out["duplicate"] = True
        out["dedupKey"] = dedup_key
    return out


def run_pipeline_with_dedup(
    trace: dict[str, Any],
    directory_override: str | None = None,
    parent_session_id: str | None = None,
) -> dict[str, Any]:
    dedup_key = trace_ingest_dedup_key(trace)
    if not dedup_key:
        return run_pipeline(trace, directory_override=directory_override, parent_session_id=parent_session_id)

    with _ingest_dedup_lock:
        index = _load_ingest_dedup_index()
        entry = index.get(dedup_key)
        if isinstance(entry, dict):
            status = str(entry.get("status") or "")
            run_dir_raw = str(entry.get("runDir") or "").strip()
            if status == "done" and run_dir_raw:
                run_dir = Path(run_dir_raw)
                if run_dir.is_dir():
                    print(f"[memory-worker] ingest.dedup.hit done dedupKey={dedup_key} runId={entry.get('runId')}")
                    return _pipeline_result_from_run_dir(run_dir, duplicate=True, dedup_key=dedup_key)
            if status == "running" and not _ingest_entry_is_stale_running(entry):
                print(f"[memory-worker] ingest.dedup.hit running dedupKey={dedup_key} runId={entry.get('runId')}")
                return {
                    "ok": True,
                    "duplicate": True,
                    "dedupKey": dedup_key,
                    "runId": entry.get("runId"),
                    "runDir": entry.get("runDir"),
                    "message": "ingest already in progress for this assistant stop message",
                }
            if status == "failed" and _ingest_entry_failed_blocks_reingest(entry):
                run_dir_raw = str(entry.get("runDir") or "").strip()
                print(f"[memory-worker] ingest.dedup.hit failed dedupKey={dedup_key} runId={entry.get('runId')}")
                out: dict[str, Any] = {
                    "ok": False,
                    "duplicate": True,
                    "dedupKey": dedup_key,
                    "runId": entry.get("runId"),
                    "runDir": entry.get("runDir"),
                    "error": entry.get("error") or "previous ingest failed for this assistant stop",
                    "message": "recent failed ingest for this assistant stop message",
                }
                if run_dir_raw and Path(run_dir_raw).is_dir():
                    out["runDir"] = run_dir_raw
                return out
        index[dedup_key] = {"status": "running", "startedAt": now_iso(), "runId": None, "runDir": None}
        _save_ingest_dedup_index(index)

    try:
        result = run_pipeline(trace, directory_override=directory_override, parent_session_id=parent_session_id)
    except Exception:
        with _ingest_dedup_lock:
            index = _load_ingest_dedup_index()
            current = index.get(dedup_key)
            if isinstance(current, dict) and str(current.get("status") or "") == "running":
                index.pop(dedup_key, None)
                _save_ingest_dedup_index(index)
        raise

    with _ingest_dedup_lock:
        index = _load_ingest_dedup_index()
        if result.get("ok"):
            index[dedup_key] = {
                "status": "done",
                "finishedAt": now_iso(),
                "runId": result.get("runId"),
                "runDir": result.get("runDir"),
            }
        else:
            index[dedup_key] = {
                "status": "failed",
                "finishedAt": now_iso(),
                "runId": result.get("runId"),
                "runDir": result.get("runDir"),
                "error": result.get("error"),
            }
        _save_ingest_dedup_index(index)
    return result


def _safe_id(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", value or "")


def _load_error_diagnosis_index() -> dict[str, Any]:
    if not ERROR_DIAGNOSIS_INDEX_PATH.exists():
        return {"diagnoses": {}}
    try:
        data = json.loads(ERROR_DIAGNOSIS_INDEX_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("diagnoses"), dict):
            return data
    except Exception:
        pass
    return {"diagnoses": {}}


def _save_error_diagnosis_index(data: dict[str, Any]) -> None:
    data["updatedAt"] = now_iso()
    write_json(ERROR_DIAGNOSIS_INDEX_PATH, data)


def _trace_primary_payload(trace: dict[str, Any]) -> dict[str, Any]:
    return trace_primary_turn(trace) if trace.get("schemaVersion") == "trace.session.v1" else trace


def _error_actions_for_subtask(subtask: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    actions = subtask.get("actions")
    if not isinstance(actions, list):
        return out
    for action in actions:
        if not isinstance(action, dict):
            continue
        has_error_status = str(action.get("status") or "") == "error"
        has_error_payload = action.get("error") not in (None, "", [], {})
        if has_error_status or has_error_payload:
            out.append(action)
    return out


def _error_diagnosis_signature(
    session_id: str,
    end_assistant_message_id: str,
    subtask: dict[str, Any],
    error_actions: list[dict[str, Any]],
) -> tuple[str, str]:
    compact_actions = [
        {
            "index": a.get("index"),
            "type": a.get("type"),
            "tool": a.get("tool"),
            "status": a.get("status"),
            "source": a.get("source"),
            "childSessionID": a.get("childSessionID"),
            "parentTaskCallID": a.get("parentTaskCallID"),
            "error": a.get("error"),
        }
        for a in (subtask.get("actions") if isinstance(subtask.get("actions"), list) else [])
        if isinstance(a, dict)
    ]
    compact_errors = [
        {
            "index": a.get("index"),
            "type": a.get("type"),
            "tool": a.get("tool"),
            "status": a.get("status"),
            "error": a.get("error"),
            "source": a.get("source"),
            "childSessionID": a.get("childSessionID"),
            "parentTaskCallID": a.get("parentTaskCallID"),
        }
        for a in error_actions
    ]
    payload = {
        "sessionId": session_id,
        "endAssistantMessageId": end_assistant_message_id,
        "subtaskIndex": subtask.get("index"),
        "subtaskId": subtask.get("subtaskId"),
        "actions": compact_actions,
        "errors": compact_errors,
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    return digest, raw


def _error_diagnosis_run_dir(
    session_id: str,
    end_assistant_message_id: str,
    subtask_index: int,
    signature_hash: str,
) -> Path:
    stamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S-%f")
    return (
        LOG_ROOT
        / f"{stamp}-{_safe_id(session_id) or 'unknown-session'}-"
        f"{_safe_id(end_assistant_message_id) or 'unknown-message'}-"
        f"subtask-{subtask_index}-error-diagnosis-{signature_hash[:8]}"
    )


def _error_diagnosis_running_is_fresh(entry: dict[str, Any]) -> bool:
    started = str(entry.get("startedAt") or "").strip()
    if not started:
        return False
    try:
        dt = datetime.fromisoformat(started.replace("Z", "+00:00"))
    except Exception:
        return False
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    age = (datetime.now(timezone.utc) - dt).total_seconds()
    return age < ERROR_DIAGNOSIS_RUNNING_STALE_SEC


def _json_preview(value: Any, limit: int = 4000) -> Any:
    if isinstance(value, str):
        return value[:limit]
    try:
        text = json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        text = str(value)
    if len(text) <= limit:
        return value
    return text[:limit]


def _compact_trace_for_error_diagnosis(
    trace: dict[str, Any],
    subtask: dict[str, Any],
    error_actions: list[dict[str, Any]],
    signature_hash: str,
) -> dict[str, Any]:
    primary = _trace_primary_payload(trace)
    session = primary.get("session") if isinstance(primary.get("session"), dict) else {}
    turn = primary.get("turn") if isinstance(primary.get("turn"), dict) else {}

    compact_actions: list[dict[str, Any]] = []
    actions = subtask.get("actions") if isinstance(subtask.get("actions"), list) else []
    for action in actions:
        if not isinstance(action, dict):
            continue
        compact_actions.append(
            {
                "index": action.get("index"),
                "type": action.get("type"),
                "tool": action.get("tool"),
                "status": action.get("status"),
                "durationMs": action.get("durationMs"),
                "tokenEstimate": action.get("tokenEstimate"),
                "source": action.get("source"),
                "childSessionID": action.get("childSessionID"),
                "parentTaskCallID": action.get("parentTaskCallID"),
                "input": _json_preview(action.get("input")),
                "output": _json_preview(action.get("output")),
                "error": _json_preview(action.get("error")),
            }
        )

    return {
        "schemaVersion": "trace.panel-analysis-input.v1",
        "diagnosisSignature": signature_hash,
        "hasError": len(error_actions) > 0,
        "session": session,
        "turn": turn,
        "subtask": {
            "index": subtask.get("index"),
            "subtaskId": subtask.get("subtaskId"),
            "title": subtask.get("title"),
            "phase": subtask.get("phase"),
            "todos": subtask.get("todos") or [],
            "metrics": subtask.get("metrics") or {},
            "actions": compact_actions,
        },
        "errorActions": [
            {
                "index": a.get("index"),
                "type": a.get("type"),
                "tool": a.get("tool"),
                "status": a.get("status"),
                "error": _json_preview(a.get("error")),
                "source": a.get("source"),
                "childSessionID": a.get("childSessionID"),
                "parentTaskCallID": a.get("parentTaskCallID"),
            }
            for a in error_actions
        ],
    }


def _render_error_diagnosis_prompt(input_payload: dict[str, Any]) -> str:
    template = (PROMPT_ROOT / "error_diagnosis_prompt.md").read_text(encoding="utf-8")
    return template.replace(
        "{{ERROR_DIAGNOSIS_INPUT_JSON}}",
        json.dumps(input_payload, ensure_ascii=False, indent=2, default=str),
    )


def _fallback_panel_analysis_from_raw(raw_text: str, has_error: bool) -> dict[str, Any] | None:
    text = (raw_text or "").strip()
    if not text:
        return None
    summary = ""
    m = re.search(r'"summary"\s*:\s*"(.*)"\s*,\s*"rootCause"', text, flags=re.S)
    if m:
        summary = m.group(1).strip()
    if not summary:
        m = re.search(r'"summary"\s*:\s*"([^"]{8,600})"', text, flags=re.S)
        if m:
            summary = m.group(1).strip()
    if not summary:
        compact = re.sub(r"\s+", " ", text)
        summary = compact[:320].strip()
    if not summary:
        return None
    return {
        "summary": summary,
        "rootCause": "",
        "causalChain": [],
        "evidence": [],
        "fixSuggestion": "",
        "confidence": "low" if has_error else "medium",
        "parseFallback": True,
    }


def opencode_get_session(session_id: str, directory: str | None = None) -> dict[str, Any] | None:
    session_id = str(session_id or "").strip()
    if not session_id:
        return None
    try:
        status, text = opencode_request("GET", f"/session/{session_id}", directory=directory)
    except Exception:
        return None
    if status != 200 or not str(text or "").strip():
        return None
    try:
        data = json.loads(text)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _is_known_panel_analysis_analyzer_session(session_id: str) -> bool:
    """True if this session was created as a panel-analysis LLM session (loop risk)."""
    session_id = str(session_id or "").strip()
    if not session_id:
        return False
    index = _load_error_diagnosis_index()
    diagnoses = index.get("diagnoses") if isinstance(index.get("diagnoses"), dict) else {}
    for entry in diagnoses.values():
        if not isinstance(entry, dict):
            continue
        if str(entry.get("diagnosisSessionID") or "").strip() == session_id:
            return True
    return False


def is_mw_internal_session(session_id: str, directory: str | None = None) -> bool:
    """Skip panel-analysis / diagnosis for memory-worker internal analyzer sessions."""
    session_id = str(session_id or "").strip()
    if not session_id:
        return False
    if _is_known_panel_analysis_analyzer_session(session_id):
        return True
    session = opencode_get_session(session_id, directory=directory)
    title = str((session or {}).get("title") or "").strip()
    prefix = (MW_SESSION_TITLE_PREFIX or "").strip()
    return bool(prefix and title.startswith(prefix))


def run_error_diagnosis_for_trace(
    trace: dict[str, Any],
    directory_override: str | None = None,
    parent_session_id: str | None = None,
) -> dict[str, Any]:
    primary = _trace_primary_payload(trace)
    session = primary.get("session") if isinstance(primary.get("session"), dict) else {}
    turn = primary.get("turn") if isinstance(primary.get("turn"), dict) else {}
    session_id = str(session.get("id") or trace_session_id(trace) or "").strip()
    end_msg_id = str(turn.get("endAssistantMessageId") or trace_primary_end_message_id(trace) or "").strip()
    trace_dir = str((session.get("directory") or "")).strip()
    effective_directory = directory_override or trace_dir or OPENCODE_DIRECTORY

    if session_id and is_mw_internal_session(session_id, directory=effective_directory):
        print(
            "[memory-worker] error-diagnosis.skip mw-internal "
            f"sessionId={session_id}"
        )
        return {
            "ok": True,
            "count": 0,
            "items": [],
            "skipped": True,
            "reason": "mw_internal_session",
            "sessionId": session_id,
        }

    subtasks = primary.get("subtasks")
    if not isinstance(subtasks, list):
        return {"ok": True, "count": 0, "items": []}

    items: list[dict[str, Any]] = []
    for subtask in subtasks:
        if not isinstance(subtask, dict):
            continue
        error_actions = _error_actions_for_subtask(subtask)
        subtask_index = int(subtask.get("index") or 0)
        signature_hash, signature_raw = _error_diagnosis_signature(
            session_id,
            end_msg_id,
            subtask,
            error_actions,
        )
        dedup_key = f"{session_id}:{end_msg_id}:{subtask.get('subtaskId') or subtask_index}:{signature_hash}"

        with _error_diagnosis_lock:
            index = _load_error_diagnosis_index()
            diagnoses = index.setdefault("diagnoses", {})
            existing = diagnoses.get(dedup_key) if isinstance(diagnoses.get(dedup_key), dict) else None
            if existing:
                status = str(existing.get("status") or "")
                # Stale "running" entries must not block a fresh panel analysis forever.
                if not (status == "running" and not _error_diagnosis_running_is_fresh(existing)):
                    items.append({**existing, "dedupKey": dedup_key, "cached": True})
                    continue

            run_dir = _error_diagnosis_run_dir(session_id, end_msg_id, subtask_index, signature_hash)
            record = {
                "status": "running",
                "dedupKey": dedup_key,
                "signatureHash": signature_hash,
                "sessionId": session_id,
                "endAssistantMessageId": end_msg_id,
                "subtaskIndex": subtask_index,
                "subtaskId": subtask.get("subtaskId"),
                "hasError": len(error_actions) > 0,
                "runDir": str(run_dir),
                "startedAt": now_iso(),
            }
            diagnoses[dedup_key] = record
            _save_error_diagnosis_index(index)

        run_dir.mkdir(parents=True, exist_ok=True)
        log_file = run_dir / "00-run.log"
        request_payload = _compact_trace_for_error_diagnosis(trace, subtask, error_actions, signature_hash)
        write_json(run_dir / "01-request.json", request_payload)
        append_log(
            log_file,
            "error_diagnosis.start",
            {
                "dedupKey": dedup_key,
                "sessionId": session_id,
                "endAssistantMessageId": end_msg_id,
                "subtaskIndex": subtask_index,
                "subtaskId": subtask.get("subtaskId"),
                "hasError": len(error_actions) > 0,
                "errorActionCount": len(error_actions),
                "effectiveDirectory": effective_directory,
            },
        )
        (run_dir / "01-signature.json").write_text(signature_raw + "\n", encoding="utf-8")
        prompt = _render_error_diagnosis_prompt(request_payload)
        (run_dir / "02-error-diagnosis-prompt.txt").write_text(prompt, encoding="utf-8")

        try:
            llm_out = opencode_generate_text(
                prompt,
                run_dir,
                log_file,
                "03-error-diagnosis",
                directory=effective_directory,
                parent_session_id=parent_session_id or session_id,
                retry_with_new_session=True,
                max_attempts=MW_ANALYZER_SESSION_ATTEMPTS,
            )
            write_json(run_dir / "04-error-diagnosis-raw.json", llm_out)
            parsed = try_parse_json_value(str(llm_out.get("rawText") or ""))
            if not isinstance(parsed, dict):
                parsed = _fallback_panel_analysis_from_raw(
                    str(llm_out.get("rawText") or ""),
                    len(error_actions) > 0,
                )
            if not isinstance(parsed, dict):
                raise RuntimeError("panel analysis output parse failed")
            result = {
                "status": "ok",
                "dedupKey": dedup_key,
                "signatureHash": signature_hash,
                "sessionId": session_id,
                "endAssistantMessageId": end_msg_id,
                "subtaskIndex": subtask_index,
                "subtaskId": subtask.get("subtaskId"),
                "hasError": len(error_actions) > 0,
                "runDir": str(run_dir),
                "diagnosisSessionID": str(((llm_out.get("session") or {}).get("id") or "")),
                "diagnosis": parsed,
                "completedAt": now_iso(),
                "errorActions": [
                    {
                        "index": a.get("index"),
                        "type": a.get("type"),
                        "tool": a.get("tool"),
                        "status": a.get("status"),
                        "error": _json_preview(a.get("error"), 1200),
                    }
                    for a in error_actions
                ],
            }
            write_json(run_dir / "05-result.json", result)
            append_log(log_file, "error_diagnosis.done", {"dedupKey": dedup_key, "diagnosisSessionID": result["diagnosisSessionID"]})
        except Exception as e:
            result = {
                "status": "failed",
                "dedupKey": dedup_key,
                "signatureHash": signature_hash,
                "sessionId": session_id,
                "endAssistantMessageId": end_msg_id,
                "subtaskIndex": subtask_index,
                "subtaskId": subtask.get("subtaskId"),
                "hasError": len(error_actions) > 0,
                "runDir": str(run_dir),
                "error": str(e),
                "completedAt": now_iso(),
            }
            write_json(run_dir / "05-result.json", result)
            append_log(log_file, "error_diagnosis.failed", {"dedupKey": dedup_key, "error": str(e)})

        with _error_diagnosis_lock:
            index = _load_error_diagnosis_index()
            diagnoses = index.setdefault("diagnoses", {})
            diagnoses[dedup_key] = result
            _save_error_diagnosis_index(index)
        items.append(result)

    return {"ok": True, "count": len(items), "items": items}


def _panel_analysis_entry_is_newer(candidate: dict[str, Any], existing: dict[str, Any]) -> bool:
    ca = str(candidate.get("completedAt") or "")
    cb = str(existing.get("completedAt") or "")
    if ca and cb:
        return ca > cb
    end_a = str(candidate.get("endAssistantMessageId") or "")
    end_b = str(existing.get("endAssistantMessageId") or "")
    return end_a > end_b


def _iter_panel_analysis_entries_for_subtask(
    session_id: str,
    subtask_id: str,
) -> list[dict[str, Any]]:
    session_id = str(session_id or "").strip()
    subtask_id = str(subtask_id or "").strip()
    if not session_id or not subtask_id:
        return []
    index = _load_error_diagnosis_index()
    diagnoses = index.get("diagnoses") if isinstance(index.get("diagnoses"), dict) else {}
    out: list[dict[str, Any]] = []
    for entry in diagnoses.values():
        if not isinstance(entry, dict):
            continue
        if str(entry.get("sessionId") or "").strip() != session_id:
            continue
        if str(entry.get("subtaskId") or "").strip() != subtask_id:
            continue
        out.append(entry)
    return out


def find_panel_analysis_for_subtask(
    session_id: str,
    subtask_id: str,
) -> dict[str, Any] | None:
    """Return the durable mark for a panel: prefer ok, else fresh running.

    Once a subtask has an ok summary, later requests must reuse it even if the
    action signature drifts (child sessions / timing fields).
    """
    entries = _iter_panel_analysis_entries_for_subtask(session_id, subtask_id)
    if not entries:
        return None
    ok_entries = [e for e in entries if str(e.get("status") or "") == "ok"]
    if ok_entries:
        best = ok_entries[0]
        for e in ok_entries[1:]:
            if _panel_analysis_entry_is_newer(e, best):
                best = e
        return {**best, "cached": True}
    running_entries = [
        e
        for e in entries
        if str(e.get("status") or "") == "running" and _error_diagnosis_running_is_fresh(e)
    ]
    if running_entries:
        best = running_entries[0]
        for e in running_entries[1:]:
            if _panel_analysis_entry_is_newer(e, best):
                best = e
        return {**best, "cached": True}
    return None


def panel_analysis_for_session(session_id: str) -> dict[str, Any]:
    session_id = str(session_id or "").strip()
    if not session_id:
        return {"ok": False, "error": "sessionId is required", "count": 0, "items": []}
    index = _load_error_diagnosis_index()
    diagnoses = index.get("diagnoses") if isinstance(index.get("diagnoses"), dict) else {}
    items_by_subtask: dict[str, dict[str, Any]] = {}
    for entry in diagnoses.values():
        if not isinstance(entry, dict):
            continue
        if str(entry.get("sessionId") or "").strip() != session_id:
            continue
        subtask_id = str(entry.get("subtaskId") or "").strip()
        if not subtask_id:
            continue
        prev = items_by_subtask.get(subtask_id)
        if prev is None or _panel_analysis_entry_is_newer(entry, prev):
            merged = dict(entry)
            merged["cached"] = True
            items_by_subtask[subtask_id] = merged
    items = list(items_by_subtask.values())
    return {"ok": True, "sessionId": session_id, "count": len(items), "items": items}


def build_current_stop_error_diagnosis(
    messages: list[dict[str, Any]],
    session_id: str,
    end_msg_id: str,
    directory_override: str | None,
    parent_session_id: str | None,
) -> dict[str, Any]:
    """Legacy helper: diagnose every subtask in the stop turn. Prefer run_panel_analysis_for_subtask."""
    trace = trace_parser.build_session_trace_bundle(
        messages=messages,
        primary_end_assistant_message_id=end_msg_id,
        session={"id": session_id, "directory": directory_override},
        directory=directory_override,
        max_turns=1,
        fetch_messages=opencode_get_messages,
    )
    if not trace:
        return {"ok": True, "count": 0, "items": [], "reason": "current_trace_not_available"}
    return run_error_diagnosis_for_trace(
        trace,
        directory_override=directory_override,
        parent_session_id=parent_session_id,
    )


def run_panel_analysis_for_subtask(
    messages: list[dict[str, Any]],
    session_id: str,
    subtask_id: str,
    directory_override: str | None,
    parent_session_id: str | None,
) -> dict[str, Any]:
    """Run Trace summary / error diagnosis for one sealed panel, independent of ingest."""
    session_id = str(session_id or "").strip()
    subtask_id = str(subtask_id or "").strip()
    if not session_id or not subtask_id:
        return {"ok": False, "error": "sessionId and subtaskId are required", "count": 0, "items": []}

    if is_mw_internal_session(session_id, directory=directory_override):
        print(
            "[memory-worker] panel-analysis.skip mw-internal "
            f"sessionId={session_id} subtaskId={subtask_id}"
        )
        return {
            "ok": True,
            "count": 0,
            "items": [],
            "skipped": True,
            "reason": "mw_internal_session",
            "sessionId": session_id,
            "subtaskId": subtask_id,
        }

    # Durable mark: one successful summary per panel (sessionId + subtaskId).
    existing = find_panel_analysis_for_subtask(session_id, subtask_id)
    if existing:
        print(
            "[memory-worker] panel-analysis.cache-hit "
            f"sessionId={session_id} subtaskId={subtask_id} status={existing.get('status')} "
            f"signature={existing.get('signatureHash') or ''}"
        )
        return {
            "ok": True,
            "count": 1,
            "items": [existing],
            "sessionId": session_id,
            "subtaskId": subtask_id,
            "cached": True,
        }

    trace = trace_parser.build_subtask_panel_trace(
        messages=messages,
        subtask_id=subtask_id,
        session={"id": session_id, "directory": directory_override},
        directory=directory_override,
        fetch_messages=opencode_get_messages,
    )
    if not trace:
        return {
            "ok": False,
            "error": "panel_trace_not_available",
            "reason": "panel_trace_not_available",
            "count": 0,
            "items": [],
            "sessionId": session_id,
            "subtaskId": subtask_id,
        }
    result = run_error_diagnosis_for_trace(
        trace,
        directory_override=directory_override,
        parent_session_id=parent_session_id or session_id,
    )
    result["sessionId"] = session_id
    result["subtaskId"] = subtask_id
    return result


def build_task_switch_run_dir(session_id: str, end_assistant_message_id: str) -> Path:
    stamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S-%f")
    return LOG_ROOT / f"{stamp}-{_safe_id(session_id) or 'unknown-session'}-{_safe_id(end_assistant_message_id) or 'unknown-turn'}-task-switch-{uuid4().hex[:8]}"


def _complete_task_switch_extraction(
    *,
    session_id: str,
    session_key: str,
    directory_override: str | None,
    parent_session_id: str | None,
    fork_meta: dict[str, Any] | None,
    previous_task_turns: list[dict[str, Any]],
    current_turn: dict[str, Any],
    user_prompt: str,
    switch_run_dir: Path,
    switch_log_file: Path,
    switch_output: dict[str, Any],
    decision: dict[str, Any],
) -> None:
    """Background: build previous-task trace and run analyzer/writer pipeline."""
    previous_end_msg_id = str(previous_task_turns[-1].get("endAssistantMessageId") or "")
    try:
        messages = opencode_get_messages(session_id, directory=directory_override)
        trace = trace_parser.build_session_trace_bundle(
            messages=messages,
            primary_end_assistant_message_id=previous_end_msg_id,
            session={"id": session_id, "directory": directory_override},
            directory=directory_override,
            max_turns=len(previous_task_turns),
            fetch_messages=opencode_get_messages,
        )
        if not trace:
            write_json(
                switch_run_dir / "02-trace-build-failed.json",
                {
                    "previousTaskTurns": previous_task_turns,
                    "previousEndAssistantMessageId": previous_end_msg_id,
                },
            )
            append_log(switch_log_file, "task_switch.extraction.failed", {"reason": "trace_build_failed"})
            failed_segment = _task_segment_summary(previous_task_turns)
            if failed_segment.get("taskId"):
                mark_task_skill_status(
                    session_id,
                    failed_segment,
                    status="none",
                    error="trace_build_failed",
                )
            return

        if fork_meta:
            fork_data = trace_parser.build_fork_comparison(
                fork_meta=fork_meta,
                directory=directory_override,
                fetch_messages=opencode_get_messages,
            )
            if fork_data:
                trace["fork"] = fork_data

        extracted_range = {
            "fromEndAssistantMessageId": str(previous_task_turns[0].get("endAssistantMessageId") or ""),
            "toEndAssistantMessageId": previous_end_msg_id,
            "turnCount": len(previous_task_turns),
        }
        write_json(
            switch_run_dir / "02-extraction-range.json",
            {
                **extracted_range,
                "previousTaskTurns": previous_task_turns,
                "nextInFlightTurn": current_turn,
            },
        )
        write_json(switch_run_dir / "03-extracted-trace.json", trace)

        extracted_task_segment = _task_segment_summary(previous_task_turns)
        result = run_pipeline_with_dedup(
            trace,
            directory_override=directory_override,
            parent_session_id=parent_session_id,
        )
        register_task_skill_result(session_id, extracted_task_segment, result)
        write_json(switch_run_dir / "04-pipeline-result.json", result)

        with _task_switch_lock:
            state = _load_task_switch_state()
            sessions = state.setdefault("sessions", {})
            existing = sessions.get(session_key) if isinstance(sessions.get(session_key), dict) else {}
            completed_turn = _completed_in_flight_turn(existing, user_prompt) if isinstance(existing, dict) else None
            next_pending = [completed_turn] if completed_turn else []
            sessions[session_key] = {
                "sessionId": session_id,
                "directory": directory_override or "",
                "pendingTurns": next_pending,
                **(
                    {}
                    if completed_turn
                    else {
                        "inFlightTurn": current_turn,
                        "inFlightTaskSwitch": {
                            "status": "done",
                            "runDir": str(switch_run_dir),
                            "mode": switch_output.get("mode"),
                            "decision": decision,
                            "extractedRange": extracted_range,
                            "pipelineRunDir": result.get("runDir"),
                        },
                    }
                ),
                "updatedAt": now_iso(),
                "lastTaskSwitchRunDir": str(switch_run_dir),
                "lastExtractedRange": extracted_range,
                "lastExtractedTurns": existing.get("lastExtractedTurns") if isinstance(existing, dict) else previous_task_turns,
            }
            _save_task_switch_state(state)
        write_json(
            switch_run_dir / "05-state-after.json",
            {
                "reason": "task_switched_pipeline_done",
                "decision": decision,
                "pendingTurnsAfter": next_pending,
                "inFlightTurn": None if completed_turn else current_turn,
                "lastExtractedRange": extracted_range,
                "pipelineRunDir": result.get("runDir"),
                "statePath": str(TASK_SWITCH_STATE_PATH),
            },
        )
        append_log(
            switch_log_file,
            "task_switch.extraction.done",
            {"pipelineRunDir": result.get("runDir"), "taskSwitched": True},
        )
    except Exception as e:
        append_log(switch_log_file, "task_switch.extraction.failed", {"error": str(e)})
        write_json(switch_run_dir / "04-pipeline-result.json", {"ok": False, "error": str(e)})
        try:
            failed_segment = _task_segment_summary(previous_task_turns)
            if failed_segment.get("taskId"):
                mark_task_skill_status(
                    session_id,
                    failed_segment,
                    status="error",
                    error=str(e),
                )
        except Exception:
            pass


def _message_index_by_id(messages: list[dict[str, Any]], message_id: str) -> int:
    message_id = str(message_id or "").strip()
    if not message_id:
        return -1
    for i, msg in enumerate(messages):
        info = msg.get("info") if isinstance(msg.get("info"), dict) else {}
        if str(info.get("id") or "") == message_id:
            return i
    return -1


def _resolve_turn_end_at_or_before(messages: list[dict[str, Any]], anchor_message_id: str) -> str:
    anchor_idx = _message_index_by_id(messages, anchor_message_id)
    if anchor_idx < 0:
        return ""
    for i in range(anchor_idx, -1, -1):
        info = messages[i].get("info") if isinstance(messages[i].get("info"), dict) else {}
        if info.get("role") == "assistant":
            return str(info.get("id") or "")
    return ""


def _truncate_turn_records_at_anchor(
    messages: list[dict[str, Any]],
    turns: list[dict[str, Any]],
    anchor_message_id: str,
) -> list[dict[str, Any]]:
    turn_end = _resolve_turn_end_at_or_before(messages, anchor_message_id)
    if not turn_end:
        return _dedupe_turn_records(turns)
    anchor_end_idx = _message_index_by_id(messages, turn_end)
    out: list[dict[str, Any]] = []
    for turn in _dedupe_turn_records(turns):
        end_id = str(turn.get("endAssistantMessageId") or "").strip()
        end_idx = _message_index_by_id(messages, end_id)
        if end_idx < 0:
            continue
        if end_idx <= anchor_end_idx:
            out.append(turn)
    return out


def _truncate_task_switch_state_for_anchor(
    parent_state: dict[str, Any],
    messages: list[dict[str, Any]],
    anchor_message_id: str,
) -> dict[str, Any]:
    truncated = {**parent_state}
    if not anchor_message_id:
        return truncated
    last_turns = truncated.get("lastExtractedTurns")
    if isinstance(last_turns, list):
        truncated["lastExtractedTurns"] = _truncate_turn_records_at_anchor(messages, last_turns, anchor_message_id)
    pending = truncated.get("pendingTurns")
    if isinstance(pending, list):
        truncated["pendingTurns"] = _truncate_turn_records_at_anchor(messages, pending, anchor_message_id)
    in_flight = truncated.get("inFlightTurn")
    if isinstance(in_flight, dict):
        end_id = str(in_flight.get("endAssistantMessageId") or "").strip()
        turn_end = _resolve_turn_end_at_or_before(messages, anchor_message_id)
        end_idx = _message_index_by_id(messages, end_id) if end_id else -1
        anchor_idx = _message_index_by_id(messages, turn_end) if turn_end else -1
        if end_idx > anchor_idx:
            truncated["inFlightTurn"] = None
    truncated["inFlightTaskSwitch"] = None
    return truncated


def _copy_task_skill_index_for_fork(
    *,
    source_session_id: str,
    fork_session_id: str,
    inherited_tabs: list[dict[str, Any]],
    directory_override: str | None = None,
) -> int:
    if not inherited_tabs:
        return 0
    index = _load_task_skill_index()
    tasks = index.setdefault("tasks", {})
    copied = 0
    for tab in inherited_tabs:
        if not isinstance(tab, dict):
            continue
        fork_task_id = str(tab.get("taskId") or "").strip()
        source_task_id = str(tab.get("sourceTaskId") or tab.get("taskId") or "").strip()
        if not fork_task_id or not source_task_id:
            continue
        skills, parent_entry = _collect_skills_for_session_task(
            source_session_id,
            source_task_id,
            directory_override,
        )
        if not skills:
            continue
        task_segment = {
            key: tab.get(key)
            for key in (
                "fromStartUserMessageId",
                "fromEndAssistantMessageId",
                "toEndAssistantMessageId",
                "turnCount",
                "title",
                "description",
                "summary",
            )
            if tab.get(key) is not None
        }
        fork_key = _task_skill_key(fork_session_id, fork_task_id)
        tasks[fork_key] = {
            **(parent_entry if isinstance(parent_entry, dict) else {}),
            "sessionId": fork_session_id,
            "taskId": fork_task_id,
            "taskSegment": task_segment or (parent_entry.get("taskSegment") if isinstance(parent_entry, dict) else {}),
            "status": "ready",
            "skills": skills,
            "inheritedFrom": {
                "sessionId": source_session_id,
                "taskId": source_task_id,
            },
            "updatedAt": now_iso(),
        }
        for skill in skills:
            skill_path = str(skill.get("skillPath") or "").strip()
            if not skill_path:
                continue
            _append_fork_skill_alias(
                Path(skill_path),
                fork_session_id=fork_session_id,
                fork_task_id=fork_task_id,
                source_session_id=source_session_id,
                source_task_id=source_task_id,
            )
        copied += 1
    if copied:
        _save_task_skill_index(index)
    return copied


def _persist_inherited_fork_tabs(
    session_id: str,
    directory_override: str | None,
    inherited_tabs: list[dict[str, Any]],
    *,
    source_parent_session_id: str = "",
) -> None:
    worker_tabs: list[dict[str, Any]] = []
    for tab in inherited_tabs:
        if not isinstance(tab, dict):
            continue
        task_id = str(tab.get("taskId") or "").strip()
        if not task_id:
            continue
        status = str(tab.get("status") or "pending").strip()
        worker_tabs.append(
            {
                "taskId": task_id,
                "status": "extracted" if status == "extracted" else "pending",
                "fromStartUserMessageId": str(tab.get("fromStartUserMessageId") or ""),
                "fromEndAssistantMessageId": str(tab.get("fromEndAssistantMessageId") or ""),
                "toEndAssistantMessageId": str(tab.get("toEndAssistantMessageId") or ""),
                "turnCount": int(tab.get("turnCount") or 0),
                "title": str(tab.get("title") or "").strip(),
                "description": str(tab.get("description") or "").strip(),
                "summary": str(tab.get("summary") or "").strip(),
                "taskSwitchRunDir": str(tab.get("taskSwitchRunDir") or "").strip(),
                "pipelineRunDir": str(tab.get("pipelineRunDir") or "").strip(),
                "sourceTaskId": str(tab.get("sourceTaskId") or "").strip(),
                "sourceParentSessionId": str(tab.get("sourceParentSessionId") or source_parent_session_id or "").strip(),
                **({"provisional": True} if tab.get("provisional") else {}),
            }
        )
    if not worker_tabs:
        return
    session_key = _task_switch_session_key(session_id, directory_override)
    with _task_segments_lock:
        index = _load_task_segments_index()
        sessions = index.setdefault("sessions", {})
        entry = sessions.setdefault(
            session_key,
            {"sessionId": session_id, "directory": (directory_override or "").strip(), "tabs": []},
        )
        entry["tabs"] = worker_tabs
        if source_parent_session_id:
            entry["forkSourceParentSessionId"] = source_parent_session_id
        entry["updatedAt"] = now_iso()
        _save_task_segments_index(index)


def _inherit_task_switch_state_for_fork(
    *,
    fork_meta: dict[str, Any] | None,
    session_id: str,
    directory_override: str | None,
    fork_anchor_message_id: str | None = None,
    parent_messages: list[dict[str, Any]] | None = None,
) -> bool:
    if not isinstance(fork_meta, dict):
        return False
    source_parent = str(fork_meta.get("sourceParentSessionId") or "").strip()
    forked_id = str(fork_meta.get("forkedSessionId") or "").strip()
    if not source_parent or not forked_id or forked_id != session_id:
        return False

    parent_key = _task_switch_session_key(source_parent, directory_override)
    fork_key = _task_switch_session_key(session_id, directory_override)

    with _task_switch_lock:
        state = _load_task_switch_state()
        sessions = state.setdefault("sessions", {})
        fork_state = sessions.get(fork_key) if isinstance(sessions.get(fork_key), dict) else {}
        if isinstance(fork_state, dict) and (
            _dedupe_turn_records(fork_state.get("pendingTurns"))
            or fork_state.get("lastExtractedTurns")
            or fork_state.get("lastExtractedRange")
        ):
            return False
        parent_state = sessions.get(parent_key)
        if not isinstance(parent_state, dict):
            return False
        next_state = parent_state
        anchor = str(fork_anchor_message_id or "").strip()
        if anchor and isinstance(parent_messages, list) and parent_messages:
            next_state = _truncate_task_switch_state_for_anchor(parent_state, parent_messages, anchor)
        sessions[fork_key] = {
            **next_state,
            "sessionId": session_id,
            "updatedAt": now_iso(),
        }
        _save_task_switch_state(state)
        return True


def inherit_fork_task_state(body: dict[str, Any]) -> dict[str, Any]:
    session_id = str(body.get("sessionId") or "").strip()
    source_parent = str(body.get("sourceParentSessionId") or "").strip()
    directory_override = str(body.get("directory") or "").strip() or None
    fork_anchor_message_id = str(body.get("forkAnchorMessageId") or "").strip() or None
    inherited_tabs_raw = body.get("inheritedTabs") if isinstance(body.get("inheritedTabs"), list) else []
    inherited_tabs = [tab for tab in inherited_tabs_raw if isinstance(tab, dict)]
    if not session_id or not source_parent:
        return {"ok": False, "error": "sessionId and sourceParentSessionId are required"}

    parent_messages: list[dict[str, Any]] = []
    if fork_anchor_message_id:
        try:
            parent_messages = opencode_get_messages(source_parent, directory=directory_override)
        except Exception:
            parent_messages = []

    inherited = _inherit_task_switch_state_for_fork(
        fork_meta={"sourceParentSessionId": source_parent, "forkedSessionId": session_id},
        session_id=session_id,
        directory_override=directory_override,
        fork_anchor_message_id=fork_anchor_message_id,
        parent_messages=parent_messages,
    )
    skill_count = _copy_task_skill_index_for_fork(
        source_session_id=source_parent,
        fork_session_id=session_id,
        inherited_tabs=inherited_tabs,
        directory_override=directory_override,
    )
    if inherited_tabs:
        _persist_inherited_fork_tabs(
            session_id,
            directory_override,
            inherited_tabs,
            source_parent_session_id=source_parent,
        )
    return {
        "ok": True,
        "inherited": inherited,
        "skillTabsCopied": skill_count,
        "tabCount": len(inherited_tabs),
    }


def process_user_prompt_task_switch(
    messages: list[dict[str, Any]],
    session_id: str,
    user_prompt: str,
    directory_override: str | None,
    parent_session_id: str | None,
    fork_meta: dict[str, Any] | None,
) -> dict[str, Any]:
    user_prompt = _normalize_user_prompt(user_prompt)
    if not session_id or not user_prompt:
        return {"ok": False, "error": "sessionId and userPrompt are required"}

    _inherit_task_switch_state_for_fork(
        fork_meta=fork_meta,
        session_id=session_id,
        directory_override=directory_override,
    )

    prompt_records = trace_parser.collect_turn_prompt_records(messages)
    completed_turns = _dedupe_turn_records([_turn_record_for_state(x) for x in prompt_records])
    current_turn = {
        "userInput": user_prompt,
        "startUserMessageId": "",
        "endAssistantMessageId": "",
        "startIndex": None,
        "endIndex": None,
        "created": None,
        "completed": None,
    }
    session_key = _task_switch_session_key(session_id, directory_override)
    switch_run_dir = build_task_switch_run_dir(session_id, f"prompt-{uuid4().hex[:8]}")
    switch_run_dir.mkdir(parents=True, exist_ok=True)
    switch_log_file = switch_run_dir / "00-run.log"
    append_log(
        switch_log_file,
        "task_switch.prompt_ingest.start",
        {"sessionId": session_id, "sessionKey": session_key, "completedTurnCount": len(completed_turns)},
    )

    with _task_switch_lock:
        state = _load_task_switch_state()
        sessions = state.setdefault("sessions", {})
        session_state = sessions.get(session_key) if isinstance(sessions.get(session_key), dict) else {}
        pending_turns = _dedupe_turn_records(session_state.get("pendingTurns") if isinstance(session_state, dict) else [])
        if not pending_turns:
            pending_turns = completed_turns
        in_flight_turn = session_state.get("inFlightTurn") if isinstance(session_state, dict) else None
        write_json(
            switch_run_dir / "00-state-before.json",
            {
                "sessionKey": session_key,
                "sessionId": session_id,
                "directory": directory_override or "",
                "currentTurn": current_turn,
                "pendingTurnsBefore": pending_turns,
                "completedTurns": completed_turns,
                "inFlightTurn": in_flight_turn if isinstance(in_flight_turn, dict) else None,
                "statePath": str(TASK_SWITCH_STATE_PATH),
            },
        )
        if isinstance(in_flight_turn, dict) and _same_user_prompt(str(in_flight_turn.get("userInput") or ""), user_prompt):
            in_flight_switch = session_state.get("inFlightTaskSwitch") if isinstance(session_state, dict) else None
            in_flight_decision = in_flight_switch.get("decision") if isinstance(in_flight_switch, dict) else None
            _save_task_switch_state(state)
            append_log(switch_log_file, "task_switch.prompt_ingest.skip", {"reason": "duplicate_in_flight_prompt"})
            return _skip_ingest_response(
                "duplicate_in_flight_prompt",
                session_id,
                current_turn,
                pending_turns,
                {
                    "runDir": str(switch_run_dir),
                    "decision": in_flight_decision,
                },
                directory_override=directory_override,
            )
        if not pending_turns:
            sessions[session_key] = {
                "sessionId": session_id,
                "directory": directory_override or "",
                "pendingTurns": [],
                "inFlightTurn": current_turn,
                "inFlightTaskSwitch": {
                    "status": "waiting_for_completed_turn",
                    "runDir": str(switch_run_dir),
                    "mode": "none",
                    "decision": None,
                },
                "updatedAt": now_iso(),
                "lastTaskSwitchRunDir": str(switch_run_dir),
            }
            _save_task_switch_state(state)
            write_json(
                switch_run_dir / "01-state-after.json",
                {
                    "reason": "first_prompt_waiting_for_completed_turn",
                    "pendingTurnsAfter": [],
                    "inFlightTurn": current_turn,
                    "statePath": str(TASK_SWITCH_STATE_PATH),
                },
            )
            append_log(switch_log_file, "task_switch.prompt_ingest.skip", {"reason": "first_prompt_waiting_for_completed_turn"})
            return _skip_ingest_response(
                "first_prompt_waiting_for_completed_turn",
                session_id,
                current_turn,
                [],
                {"runDir": str(switch_run_dir), "decision": None},
                directory_override=directory_override,
            )

        sessions[session_key] = {
            "sessionId": session_id,
            "directory": directory_override or "",
            "pendingTurns": pending_turns,
            "inFlightTurn": current_turn,
            "inFlightTaskSwitch": {
                "status": "running",
                "runDir": str(switch_run_dir),
                "mode": None,
                "decision": None,
            },
            "updatedAt": now_iso(),
            "lastTaskSwitchRunDir": str(switch_run_dir),
        }
        _save_task_switch_state(state)

    append_log(
        switch_log_file,
        "task_switch.judge.scheduled",
        {"sessionId": session_id, "trigger": "user_prompt", "pendingTurnCount": len(pending_turns)},
    )
    threading.Thread(
        target=_run_user_prompt_task_switch_worker,
        kwargs={
            "session_id": session_id,
            "session_key": session_key,
            "directory_override": directory_override,
            "parent_session_id": parent_session_id,
            "fork_meta": fork_meta,
            "pending_turns": pending_turns,
            "current_turn": current_turn,
            "user_prompt": user_prompt,
            "switch_run_dir": switch_run_dir,
            "switch_log_file": switch_log_file,
        },
        daemon=True,
    ).start()
    return {
        "ok": True,
        "accepted": True,
        "reason": "task_switch_judge_started",
        "runDir": str(switch_run_dir),
        "taskSwitch": {"runDir": str(switch_run_dir), "mode": None, "decision": None},
        "pendingTurnCount": len(pending_turns),
    }


def _run_user_prompt_task_switch_worker(
    *,
    session_id: str,
    session_key: str,
    directory_override: str | None,
    parent_session_id: str | None,
    fork_meta: dict[str, Any] | None,
    pending_turns: list[dict[str, Any]],
    current_turn: dict[str, Any],
    user_prompt: str,
    switch_run_dir: Path,
    switch_log_file: Path,
) -> None:
    write_json(switch_run_dir / "01-task-switch-input.json", task_switch_input_payload(pending_turns, current_turn))
    append_log(
        switch_log_file,
        "task_switch.start",
        {"sessionId": session_id, "trigger": "user_prompt", "pendingTurnCount": len(pending_turns)},
    )

    try:
        switch_output = run_task_switch_judge(
            pending_turns,
            current_turn,
            switch_run_dir,
            switch_log_file,
            directory=directory_override,
        )
    except Exception as e:
        append_log(switch_log_file, "task_switch.failed", {"error": str(e)})
        with _task_switch_lock:
            state = _load_task_switch_state()
            sessions = state.setdefault("sessions", {})
            existing = sessions.get(session_key) if isinstance(sessions.get(session_key), dict) else {}
            if isinstance(existing, dict):
                sessions[session_key] = {
                    **existing,
                    "inFlightTaskSwitch": {
                        "status": "failed",
                        "runDir": str(switch_run_dir),
                        "error": str(e),
                    },
                    "updatedAt": now_iso(),
                }
                _save_task_switch_state(state)
        return

    write_json(switch_run_dir / "00-task-switch-raw.json", switch_output)
    decision = switch_output.get("analysis") if isinstance(switch_output.get("analysis"), dict) else {}
    switched = bool(decision.get("task_switched"))
    append_log(switch_log_file, "task_switch.done", {"taskSwitched": switched, "decision": decision})

    if not switched:
        with _task_switch_lock:
            state = _load_task_switch_state()
            sessions = state.setdefault("sessions", {})
            existing = sessions.get(session_key) if isinstance(sessions.get(session_key), dict) else {}
            completed_turn = _completed_in_flight_turn(existing, user_prompt) if isinstance(existing, dict) else None
            next_pending = _dedupe_turn_records([*pending_turns, completed_turn] if completed_turn else pending_turns)
            sessions[session_key] = {
                "sessionId": session_id,
                "directory": directory_override or "",
                "pendingTurns": next_pending,
                **(
                    {}
                    if completed_turn
                    else {
                        "inFlightTurn": current_turn,
                        "inFlightTaskSwitch": {
                            "status": "done",
                            "runDir": str(switch_run_dir),
                            "mode": switch_output.get("mode"),
                            "decision": decision,
                        },
                    }
                ),
                "updatedAt": now_iso(),
                "lastTaskSwitchRunDir": str(switch_run_dir),
            }
            _save_task_switch_state(state)
        write_json(
            switch_run_dir / "02-state-after.json",
            {
                "reason": "task_not_switched_waiting_for_assistant_stop",
                "decision": decision,
                "pendingTurnsAfter": next_pending,
                "inFlightTurn": None if completed_turn else current_turn,
                "statePath": str(TASK_SWITCH_STATE_PATH),
            },
        )
        return

    previous_task_turns = pending_turns
    previous_end_msg_id = str(previous_task_turns[-1].get("endAssistantMessageId") or "")
    extracted_range = {
        "fromEndAssistantMessageId": str(previous_task_turns[0].get("endAssistantMessageId") or ""),
        "toEndAssistantMessageId": previous_end_msg_id,
        "turnCount": len(previous_task_turns),
    }

    with _task_switch_lock:
        state = _load_task_switch_state()
        sessions = state.setdefault("sessions", {})
        sessions[session_key] = {
            "sessionId": session_id,
            "directory": directory_override or "",
            "pendingTurns": [],
            "inFlightTurn": current_turn,
            "inFlightTaskSwitch": {
                "status": "done",
                "runDir": str(switch_run_dir),
                "mode": switch_output.get("mode"),
                "decision": decision,
                "extractedRange": extracted_range,
                "pipelineStatus": "running",
            },
            "updatedAt": now_iso(),
            "lastTaskSwitchRunDir": str(switch_run_dir),
            "lastExtractedRange": extracted_range,
            "lastExtractedTurns": previous_task_turns,
        }
        _save_task_switch_state(state)
    write_json(
        switch_run_dir / "02-state-after.json",
        {
            "reason": "task_switched_pipeline_started",
            "decision": decision,
            "pendingTurnsAfter": [],
            "inFlightTurn": current_turn,
            "lastExtractedRange": extracted_range,
            "statePath": str(TASK_SWITCH_STATE_PATH),
        },
    )
    prev_brief = _task_brief_from_decision(decision, "previous")
    curr_brief = _task_brief_from_decision(decision, "current")
    extracted_segment = _task_segment_summary(
        previous_task_turns,
        title=prev_brief.get("title"),
        description=prev_brief.get("description"),
    )
    pending_segment = _task_segment_summary(
        [current_turn],
        title=curr_brief.get("title"),
        description=curr_brief.get("description"),
    )
    if not pending_segment.get("taskId"):
        pending_segment = _pending_task_segment_placeholder(
            current_turn,
            title=curr_brief.get("title"),
            description=curr_brief.get("description"),
        )
    _persist_task_segments(
        session_id,
        directory_override,
        extracted_task=extracted_segment if extracted_segment.get("taskId") else None,
        pending_task=pending_segment if pending_segment.get("taskId") else None,
        task_switched=True,
        task_switch_run_dir=str(switch_run_dir),
    )
    if extracted_segment.get("taskId"):
        mark_task_skill_status(
            session_id,
            extracted_segment,
            status="distilling",
            pipeline_run_dir="",
        )
        append_log(
            switch_log_file,
            "task_switch.skill_index.distilling",
            {"taskId": extracted_segment.get("taskId")},
        )

    threading.Thread(
        target=_complete_task_switch_extraction,
        kwargs={
            "session_id": session_id,
            "session_key": session_key,
            "directory_override": directory_override,
            "parent_session_id": parent_session_id,
            "fork_meta": fork_meta,
            "previous_task_turns": previous_task_turns,
            "current_turn": current_turn,
            "user_prompt": user_prompt,
            "switch_run_dir": switch_run_dir,
            "switch_log_file": switch_log_file,
            "switch_output": switch_output,
            "decision": decision,
        },
        daemon=True,
    ).start()
    append_log(switch_log_file, "task_switch.extraction.scheduled", {"previousEndAssistantMessageId": previous_end_msg_id})


def process_reference_ingest_with_task_switch(
    messages: list[dict[str, Any]],
    session_id: str,
    end_msg_id: str,
    directory_override: str | None,
    parent_session_id: str | None,
    fork_meta: dict[str, Any] | None,
) -> dict[str, Any]:
    prompt_records = trace_parser.collect_turn_prompt_records(messages)
    current_record = _find_turn_prompt_record(prompt_records, end_msg_id)
    if not current_record:
        return {
            "ok": False,
            "error": "Could not find current user prompt for assistant stop message",
            "sessionId": session_id,
            "endAssistantMessageId": end_msg_id,
        }
    current_turn = _turn_record_for_state(current_record)
    session_key = _task_switch_session_key(session_id, directory_override)
    _inherit_task_switch_state_for_fork(
        fork_meta=fork_meta,
        session_id=session_id,
        directory_override=directory_override,
    )
    switch_run_dir = build_task_switch_run_dir(session_id, end_msg_id)
    switch_run_dir.mkdir(parents=True, exist_ok=True)
    switch_log_file = switch_run_dir / "00-run.log"
    append_log(
        switch_log_file,
        "task_switch.ingest.start",
        {"sessionId": session_id, "endAssistantMessageId": end_msg_id, "sessionKey": session_key},
    )
    # Panel Trace summary / error diagnosis is triggered separately via POST /panel-analysis
    # when each subtask panel seals — not mixed into ingest / task-switch.

    with _task_switch_lock:
        state = _load_task_switch_state()
        sessions = state.setdefault("sessions", {})
        session_state = sessions.get(session_key) if isinstance(sessions.get(session_key), dict) else {}
        pending_turns = _dedupe_turn_records(session_state.get("pendingTurns") if isinstance(session_state, dict) else [])
        write_json(
            switch_run_dir / "00-state-before.json",
            {
                "sessionKey": session_key,
                "sessionId": session_id,
                "directory": directory_override or "",
                "currentTurn": current_turn,
                "pendingTurnsBefore": pending_turns,
                "allPromptRecords": [_turn_record_for_state(x) for x in prompt_records],
                "statePath": str(TASK_SWITCH_STATE_PATH),
            },
        )
        if any(str(turn.get("endAssistantMessageId") or "") == end_msg_id for turn in pending_turns):
            _save_task_switch_state(state)
            write_json(
                switch_run_dir / "01-state-after.json",
                {
                    "reason": "duplicate_pending_turn",
                    "pendingTurnsAfter": pending_turns,
                    "statePath": str(TASK_SWITCH_STATE_PATH),
                },
            )
            append_log(switch_log_file, "task_switch.skip", {"reason": "duplicate_pending_turn", "pendingTurnCount": len(pending_turns)})
            return _skip_ingest_response(
                "duplicate_pending_turn",
                session_id,
                current_turn,
                pending_turns,
                {"runDir": str(switch_run_dir), "decision": None},
                directory_override=directory_override,
            )
        in_flight_turn = session_state.get("inFlightTurn") if isinstance(session_state, dict) else None
        if isinstance(in_flight_turn, dict) and _same_user_prompt(
            str(in_flight_turn.get("userInput") or ""),
            str(current_turn.get("userInput") or ""),
        ):
            early_switch = session_state.get("inFlightTaskSwitch") if isinstance(session_state, dict) else None
            if not _task_switch_decision_ready(early_switch):
                early_status = str(early_switch.get("status") or "") if isinstance(early_switch, dict) else ""
                if early_status != "running":
                    next_pending = _dedupe_turn_records([*pending_turns, current_turn])
                    sessions[session_key] = {
                        "sessionId": session_id,
                        "directory": directory_override or "",
                        "pendingTurns": next_pending,
                        "updatedAt": now_iso(),
                        "lastTaskSwitchRunDir": str(early_switch.get("runDir") or switch_run_dir) if isinstance(early_switch, dict) else str(switch_run_dir),
                    }
                    _save_task_switch_state(state)
                    write_json(
                        switch_run_dir / "01-state-after.json",
                        {
                            "reason": "in_flight_prompt_completed_without_judge",
                            "pendingTurnsAfter": next_pending,
                            "statePath": str(TASK_SWITCH_STATE_PATH),
                        },
                    )
                    append_log(
                        switch_log_file,
                        "task_switch.skip",
                        {"reason": "in_flight_prompt_completed_without_judge", "pendingTurnCount": len(next_pending)},
                    )
                    return _skip_ingest_response(
                        "in_flight_prompt_completed_without_judge",
                        session_id,
                        current_turn,
                        next_pending,
                        {
                            "runDir": str(early_switch.get("runDir") or switch_run_dir) if isinstance(early_switch, dict) else str(switch_run_dir),
                            "mode": early_switch.get("mode") if isinstance(early_switch, dict) else None,
                            "decision": None,
                        },
                        directory_override=directory_override,
                    )

                sessions[session_key] = {
                    **session_state,
                    "sessionId": session_id,
                    "directory": directory_override or "",
                    "pendingTurns": pending_turns,
                    "inFlightTurn": in_flight_turn,
                    "completedInFlightTurn": current_turn,
                    "updatedAt": now_iso(),
                    "lastTaskSwitchRunDir": str(early_switch.get("runDir") or switch_run_dir) if isinstance(early_switch, dict) else str(switch_run_dir),
                }
                _save_task_switch_state(state)
                write_json(
                    switch_run_dir / "01-state-after.json",
                    {
                        "reason": "early_prompt_judge_running",
                        "pendingTurnsAfter": pending_turns,
                        "completedInFlightTurn": current_turn,
                        "statePath": str(TASK_SWITCH_STATE_PATH),
                    },
                )
                append_log(
                    switch_log_file,
                    "task_switch.skip",
                    {"reason": "early_prompt_judge_running", "pendingTurnCount": len(pending_turns)},
                )
                return _skip_ingest_response(
                    "early_prompt_judge_running",
                    session_id,
                    current_turn,
                    pending_turns,
                    {
                        "runDir": str(early_switch.get("runDir") or switch_run_dir) if isinstance(early_switch, dict) else str(switch_run_dir),
                        "mode": early_switch.get("mode") if isinstance(early_switch, dict) else None,
                        "decision": None,
                    },
                    directory_override=directory_override,
                )

            early_decision = early_switch.get("decision") if isinstance(early_switch, dict) and isinstance(early_switch.get("decision"), dict) else {}
            task_switched = bool(early_decision.get("task_switched"))
            next_pending = [current_turn] if task_switched else _dedupe_turn_records([*pending_turns, current_turn])
            extracted_turns: list[dict[str, Any]] = []
            if task_switched:
                extracted_turns = _dedupe_turn_records(
                    session_state.get("lastExtractedTurns") if isinstance(session_state, dict) else []
                )
            sessions[session_key] = {
                "sessionId": session_id,
                "directory": directory_override or "",
                "pendingTurns": next_pending,
                "updatedAt": now_iso(),
                "lastTaskSwitchRunDir": str(early_switch.get("runDir") or switch_run_dir) if isinstance(early_switch, dict) else str(switch_run_dir),
                **(
                    {
                        "lastExtractedRange": early_switch.get("extractedRange"),
                        "lastExtractedTurns": extracted_turns,
                    }
                    if isinstance(early_switch, dict) and isinstance(early_switch.get("extractedRange"), dict)
                    else {}
                ),
            }
            _save_task_switch_state(state)
            write_json(
                switch_run_dir / "01-state-after.json",
                {
                    "reason": "early_prompt_already_classified",
                    "taskSwitched": task_switched,
                    "decision": early_decision,
                    "pendingTurnsAfter": next_pending,
                    "extractedTurnCount": len(extracted_turns),
                    "statePath": str(TASK_SWITCH_STATE_PATH),
                },
            )
            append_log(
                switch_log_file,
                "task_switch.skip",
                {
                    "reason": "early_prompt_already_classified",
                    "taskSwitched": task_switched,
                    "pendingTurnCount": len(next_pending),
                    "extractedTurnCount": len(extracted_turns),
                },
            )
            return _skip_ingest_response(
                "early_prompt_already_classified",
                session_id,
                current_turn,
                next_pending,
                {
                    "runDir": str(early_switch.get("runDir") or switch_run_dir) if isinstance(early_switch, dict) else str(switch_run_dir),
                    "mode": early_switch.get("mode") if isinstance(early_switch, dict) else None,
                    "decision": early_decision,
                },
                directory_override=directory_override,
                task_switched=task_switched,
                extracted_turns=extracted_turns if task_switched else None,
                extracted_brief=_task_brief_from_decision(early_decision, "previous") if task_switched else None,
                pending_brief=_task_brief_from_decision(early_decision, "current"),
            )
        if not pending_turns:
            next_pending = [current_turn]
            sessions[session_key] = {
                "sessionId": session_id,
                "directory": directory_override or "",
                "pendingTurns": next_pending,
                "updatedAt": now_iso(),
                "lastTaskSwitchRunDir": str(switch_run_dir),
            }
            _save_task_switch_state(state)
            write_json(
                switch_run_dir / "01-state-after.json",
                {
                    "reason": "first_turn_waiting_for_next_prompt",
                    "pendingTurnsAfter": next_pending,
                    "statePath": str(TASK_SWITCH_STATE_PATH),
                },
            )
            append_log(switch_log_file, "task_switch.skip", {"reason": "first_turn_waiting_for_next_prompt", "pendingTurnCount": len(next_pending)})
            return _skip_ingest_response(
                "first_turn_waiting_for_next_prompt",
                session_id,
                current_turn,
                next_pending,
                {"runDir": str(switch_run_dir), "decision": None},
                directory_override=directory_override,
            )

        # Turn completed without a matching in-flight prompt (e.g. page reload). Append only — never re-judge.
        next_pending = _dedupe_turn_records([*pending_turns, current_turn]) if pending_turns else [current_turn]
        sessions[session_key] = {
            "sessionId": session_id,
            "directory": directory_override or "",
            "pendingTurns": next_pending,
            "updatedAt": now_iso(),
            "lastTaskSwitchRunDir": str(switch_run_dir),
        }
        _save_task_switch_state(state)
        write_json(
            switch_run_dir / "01-state-after.json",
            {
                "reason": "turn_completed_append_pending",
                "pendingTurnsAfter": next_pending,
                "statePath": str(TASK_SWITCH_STATE_PATH),
            },
        )
        append_log(
            switch_log_file,
            "turn_completed.append_pending",
            {"pendingTurnCount": len(next_pending), "note": "no task switch judge on ingest"},
        )
        return _skip_ingest_response(
            "turn_completed_append_pending",
            session_id,
            current_turn,
            next_pending,
            {"runDir": str(switch_run_dir), "decision": None},
            directory_override=directory_override,
        )


def extract_skill_fields(skill_md: str, default_name: str) -> tuple[str, str]:
    name = default_name
    description = ""
    fm = re.search(r"^---\s*\n(.*?)\n---", skill_md, flags=re.M | re.S)
    if fm:
        front = fm.group(1)
        m_name = re.search(r"^\s*name\s*:\s*(.+)\s*$", front, flags=re.M)
        m_desc = re.search(r"^\s*description\s*:\s*(.+)\s*$", front, flags=re.M)
        if m_name:
            name = m_name.group(1).strip().strip("'\"")
        if m_desc:
            description = m_desc.group(1).strip().strip("'\"")
    if not description:
        body = re.sub(r"^---.*?---\s*", "", skill_md, flags=re.S)
        parts = [x.strip() for x in re.split(r"\n\s*\n", body) if x.strip()]
        description = parts[0] if parts else ""
    return name, description


def build_pool_summary(project_dir: Path) -> dict[str, Any]:
    roots = configured_skill_roots(project_dir)
    skills: list[dict[str, Any]] = []
    for root in roots:
        if not root.exists():
            continue
        for child in root.iterdir():
            if not child.is_dir():
                continue
            skill_md = child / "SKILL.md"
            if not skill_md.exists():
                continue
            try:
                content = skill_md.read_text(encoding="utf-8")
            except Exception:
                continue
            skill_name, desc = extract_skill_fields(content, child.name)
            skills.append(
                {
                    "skill_name": skill_name,
                    "description": desc,
                    "source_skill_absolute_path": str(child.resolve()),
                    "skill_md_path": str(skill_md.resolve()),
                }
            )
    return {
        "generatedAt": now_iso(),
        "roots": [str(x.resolve()) for x in roots],
        "skills": skills,
    }


def opencode_basic_auth_header() -> dict[str, str]:
    """When `opencode serve` sets OPENCODE_SERVER_PASSWORD, every HTTP hop needs Basic auth."""
    pwd = (os.environ.get("VITE_OPENCODE_SERVER_PASSWORD") or os.environ.get("OPENCODE_SERVER_PASSWORD") or "").strip()
    if not pwd:
        return {}
    user = (
        (os.environ.get("VITE_OPENCODE_SERVER_USERNAME") or os.environ.get("OPENCODE_SERVER_USERNAME") or "opencode").strip()
        or "opencode"
    )
    token = base64.b64encode(f"{user}:{pwd}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


def _is_timeout_error(err: BaseException) -> bool:
    if isinstance(err, TimeoutError):
        return True
    if isinstance(err, URLError) and err.reason is not None:
        return _is_timeout_error(err.reason)  # type: ignore[arg-type]
    msg = str(err).lower()
    return "timed out" in msg or "timeout" in msg


def opencode_request(
    method: str,
    api_path: str,
    body: dict[str, Any] | None = None,
    directory: str | None = None,
    *,
    timeout_sec: int | None = None,
) -> tuple[int, str]:
    url = f"{OPENCODE_BASE}{api_path}"
    headers = {
        "x-opencode-directory": directory or OPENCODE_DIRECTORY,
        **opencode_basic_auth_header(),
    }
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = Request(url, data=data, headers=headers, method=method)
    limit = MW_OPENCODE_HTTP_TIMEOUT_SEC if timeout_sec is None else max(30, int(timeout_sec))
    try:
        with urlopen(req, timeout=limit) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except HTTPError as e:
        text = e.read().decode("utf-8", errors="replace")
        return e.code, text
    except Exception as e:
        if _is_timeout_error(e):
            raise RuntimeError(
                f"opencode HTTP timed out after {limit}s ({method} {api_path})"
            ) from e
        raise


def opencode_update_session_title(session_id: str, title: str, directory: str | None = None) -> None:
    if not session_id or not title:
        return
    status, raw = opencode_request("PATCH", f"/session/{session_id}", {"title": title}, directory=directory)
    if status != 200:
        raise RuntimeError(f"update session title failed: {status} {raw}")


def opencode_create_session(
    directory: str | None = None,
    parent_session_id: str | None = None,
    *,
    internal_label: str | None = None,
) -> dict[str, Any]:
    if MW_SESSION_STRATEGY == "fork" and parent_session_id:
        status, text = opencode_request("POST", f"/session/{parent_session_id}/fork", {}, directory=directory)
        if status == 200 and text.strip():
            session = json.loads(text)
            session_id = str(session.get("id") or "")
            if internal_label and session_id and MW_SESSION_TITLE_PREFIX:
                opencode_update_session_title(
                    session_id,
                    f"{MW_SESSION_TITLE_PREFIX} {internal_label}",
                    directory=directory,
                )
            return session
        # Fall back to new session when fork fails
    status, text = opencode_request("POST", "/session", {}, directory=directory)
    if status != 200:
        raise RuntimeError(f"create session failed: {status} {text}")
    if text.strip():
        session = json.loads(text)
    else:
        s2, t2 = opencode_request("GET", "/session", directory=directory)
        if s2 != 200:
            raise RuntimeError(f"list session fallback failed: {s2} {t2}")
        arr = json.loads(t2)
        if not isinstance(arr, list) or not arr:
            raise RuntimeError("create session fallback empty list")
        arr.sort(key=lambda x: ((x.get("time") or {}).get("updated") or 0), reverse=True)
        session = arr[0]
    session_id = str(session.get("id") or "")
    if internal_label and session_id and MW_SESSION_TITLE_PREFIX:
        opencode_update_session_title(
            session_id,
            f"{MW_SESSION_TITLE_PREFIX} {internal_label}",
            directory=directory,
        )
        session["title"] = f"{MW_SESSION_TITLE_PREFIX} {internal_label}"
    return session


def opencode_get_messages(session_id: str, directory: str | None = None) -> list[dict[str, Any]]:
    status, text = opencode_request("GET", f"/session/{session_id}/message", directory=directory)
    if status != 200:
        raise RuntimeError(f"get messages failed: {status} {text}")
    data = json.loads(text)
    return data if isinstance(data, list) else []


def parse_model_ref_to_body(ref: str) -> dict[str, str]:
    """Parse `providerID/modelID` into OpenCode message body.model shape."""
    t = (ref or "").strip()
    i = t.find("/")
    if i <= 0 or i >= len(t) - 1:
        raise ValueError(f"Invalid model ref (expected providerID/modelID): {ref!r}")
    provider_id = t[:i].strip()
    model_id = t[i + 1 :].strip()
    if not provider_id or not model_id:
        raise ValueError(f"Invalid model ref (expected providerID/modelID): {ref!r}")
    return {"providerID": provider_id, "modelID": model_id}


def opencode_send_message(
    session_id: str,
    text: str,
    directory: str | None = None,
    *,
    model: str | None = None,
) -> None:
    model_ref = (model or "").strip() or MW_DEFAULT_MODEL_REF
    body = {
        "parts": [{"type": "text", "text": text}],
        "model": parse_model_ref_to_body(model_ref),
    }
    status, raw = opencode_request(
        "POST",
        f"/session/{session_id}/message",
        body,
        directory=directory,
        timeout_sec=MW_OPENCODE_MESSAGE_TIMEOUT_SEC,
    )
    if status != 200:
        raise RuntimeError(f"send message failed: {status} {raw}")


def _assistant_message_ids(messages: list[dict[str, Any]]) -> set[str]:
    out: set[str] = set()
    for m in messages:
        info = m.get("info") or {}
        mid = info.get("id")
        if isinstance(mid, str) and mid:
            out.add(mid)
    return out


def opencode_generate_text(
    prompt: str,
    run_dir: Path,
    log_file: Path,
    phase: str,
    directory: str | None = None,
    parent_session_id: str | None = None,
    *,
    model: str | None = None,
    retry_with_new_session: bool = False,
    max_attempts: int | None = None,
    # Deprecated aliases kept so older call sites / hot-reload don't break mid-edit.
    retry_in_session_on_timeout: bool | None = None,
    retry_prompt: str | None = None,
) -> dict[str, Any]:
    del retry_prompt  # new-session retries always resend the original prompt
    if retry_in_session_on_timeout is not None:
        retry_with_new_session = bool(retry_in_session_on_timeout)
    model_ref = (model or "").strip() or MW_DEFAULT_MODEL_REF
    attempts_limit = (
        max_attempts
        if max_attempts is not None
        else (MW_ANALYZER_SESSION_ATTEMPTS if retry_with_new_session else 1)
    )

    last_error: Exception | None = None
    assistant: dict[str, Any] | None = None
    session: dict[str, Any] | None = None

    for attempt in range(1, attempts_limit + 1):
        append_log(
            log_file,
            f"{phase}.session.create.start",
            {"attempt": attempt, "maxAttempts": attempts_limit, "isRetry": attempt > 1},
        )
        session = opencode_create_session(
            directory=directory,
            parent_session_id=parent_session_id,
            internal_label=phase if attempt == 1 else f"{phase}-retry{attempt}",
        )
        session_id = str(session.get("id") or "")
        write_json(run_dir / f"{phase}-session.json", session)
        if attempt > 1:
            write_json(run_dir / f"{phase}-session-attempt{attempt}.json", session)
        append_log(
            log_file,
            f"{phase}.session.create.ok",
            {
                "sessionID": session_id,
                "directory": directory or OPENCODE_DIRECTORY,
                "parentSessionID": parent_session_id or "",
                "attempt": attempt,
                "maxAttempts": attempts_limit,
                "model": model_ref,
                "messageTimeoutSec": MW_OPENCODE_MESSAGE_TIMEOUT_SEC,
                "waitStopTimeoutSec": MW_ANALYZER_WAIT_PER_ATTEMPT_SEC,
            },
        )
        append_log(
            log_file,
            f"{phase}.attempt.start",
            {
                "attempt": attempt,
                "maxAttempts": attempts_limit,
                "isRetry": attempt > 1,
                "sessionID": session_id,
                "model": model_ref,
            },
        )

        try:
            before_ids = _assistant_message_ids(opencode_get_messages(session_id, directory=directory))
            opencode_send_message(session_id, prompt, directory=directory, model=model_ref)
            append_log(
                log_file,
                f"{phase}.message.send.ok",
                {"sessionID": session_id, "attempt": attempt, "model": model_ref},
            )
            assistant = wait_assistant_stop_message(session_id, before_ids, directory=directory)
            append_log(log_file, f"{phase}.wait.stop.ok", {"sessionID": session_id, "attempt": attempt})
            break
        except RuntimeError as e:
            last_error = e
            can_retry = retry_with_new_session and attempt < attempts_limit
            append_log(
                log_file,
                f"{phase}.attempt.failed",
                {
                    "sessionID": session_id,
                    "attempt": attempt,
                    "maxAttempts": attempts_limit,
                    "error": str(e),
                    "willRetryWithNewSession": can_retry,
                    "model": model_ref,
                    "waitStopTimeoutSec": MW_ANALYZER_WAIT_PER_ATTEMPT_SEC,
                    "messageTimeoutSec": MW_OPENCODE_MESSAGE_TIMEOUT_SEC,
                },
            )
            if not can_retry:
                raise RuntimeError(
                    f"{phase} failed after {attempt} attempt(s): {e}"
                ) from e

    if assistant is None or session is None:
        raise last_error or RuntimeError(f"{phase} failed with no assistant response")

    write_json(run_dir / f"{phase}-assistant-message.json", assistant)
    raw_text = extract_assistant_text(assistant)
    (run_dir / f"{phase}-assistant-text.txt").write_text(raw_text, encoding="utf-8")
    return {"session": session, "assistantMessage": assistant, "rawText": raw_text}


def extract_assistant_text(message: dict[str, Any]) -> str:
    parts = message.get("parts")
    out: list[str] = []
    if isinstance(parts, list):
        for part in parts:
            if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
                out.append(part["text"])
    if out:
        return "\n".join(out)
    info = message.get("info") or {}
    content = info.get("content")
    return content if isinstance(content, str) else ""


def try_parse_json_object(raw_text: str) -> dict[str, Any] | None:
    obj = try_parse_json_value(raw_text)
    return obj if isinstance(obj, dict) else None


def try_parse_json_value(raw_text: str) -> Any | None:
    text = (raw_text or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        pass
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.S | re.I)
    if fence:
        try:
            return json.loads(fence.group(1).strip())
        except Exception:
            pass
    object_left = text.find("{")
    object_right = text.rfind("}")
    array_left = text.find("[")
    if array_left >= 0:
        closing = text.rfind("]")
        if closing > array_left and (object_left < 0 or array_left < object_left):
            try:
                return json.loads(text[array_left : closing + 1])
            except Exception:
                pass
    left = object_left
    right = object_right
    if left >= 0 and right > left:
        try:
            return json.loads(text[left : right + 1])
        except Exception:
            pass
    return None


def is_assistant_stop_message(message: dict[str, Any]) -> bool:
    """A turn ends only when the assistant message explicitly has finish=stop."""
    info = message.get("info") or {}
    if info.get("role") != "assistant":
        return False
    nested = message.get("message")
    candidates = [
        info.get("finish"),
        nested.get("finish") if isinstance(nested, dict) else None,
        message.get("finish"),
    ]
    return any(isinstance(x, str) and x.strip().lower() == "stop" for x in candidates)


def wait_assistant_stop_message(
    session_id: str,
    before_ids: set[str],
    timeout_sec: int | None = None,
    directory: str | None = None,
) -> dict[str, Any]:
    limit = MW_ANALYZER_WAIT_PER_ATTEMPT_SEC if timeout_sec is None else max(30, int(timeout_sec))
    deadline = time.time() + limit
    while time.time() < deadline:
        messages = opencode_get_messages(session_id, directory=directory)
        fresh = []
        for m in messages:
            info = m.get("info") or {}
            mid = info.get("id")
            if not isinstance(mid, str) or mid in before_ids:
                continue
            if is_assistant_stop_message(m):
                fresh.append(m)
        if fresh:
            fresh.sort(key=lambda x: ((x.get("info") or {}).get("time") or {}).get("created") or 0)
            return fresh[-1]
        time.sleep(1.2)
    raise RuntimeError("timeout waiting analyzer assistant stop message")


def build_mock_envelope(trace: dict[str, Any], pool_summary: dict[str, Any]) -> dict[str, Any]:
    primary = trace_primary_turn(trace)
    run_id = str(((primary.get("turn") or {}).get("endAssistantMessageId") or "run-mock"))
    turn = primary.get("turn") or {}
    user_input = str(turn.get("userInput") or "")
    skills = pool_summary.get("skills") or []
    if skills:
        chosen = skills[0]
        operation = "UPDATE"
        skill_name = chosen.get("skill_name") or "mock-skill"
        source_path = chosen.get("source_skill_absolute_path") or ""
        rationale = "Matched an existing skill; proceeding with UPDATE."
    else:
        operation = "CREATE"
        skill_name = "auto-generated-skill"
        source_path = ""
        rationale = "No existing skill found; proceeding with CREATE."
    if len(user_input.strip()) < 2:
        operation = "NONE"
        skill_name = ""
        source_path = ""
        rationale = "Insufficient input; skipping generation."
    return {
        "schema_version": "2.0",
        "run_id": run_id,
        "operation": operation,
        "skill_name": skill_name,
        "source_skill_absolute_path": source_path,
        "rationale": rationale,
        "guide": {
            "overall": "MVP mock envelope; replace with real analyzer output later.",
            "folders": {
                "skill_root_layout": "Keep standard directory layout",
                "scripts": "none",
                "reference": "none",
                "data": "none",
                "other": "none",
            },
            "file_guidance": [{"relative_path": "SKILL.md", "action": "update" if operation == "UPDATE" else "create", "guidance": "Complete capability, usage, steps, constraints, and checklist."}],
            "skill_md": {
                "frontmatter_description": "This skill turns trace analysis results into a reusable workflow.",
                "section_capability": "Explain the skill's capability boundaries.",
                "section_usage": "State trigger conditions, inputs, and outputs.",
                "section_steps": "List step-by-step execution.",
                "section_cautions": "Describe risks and failure fallbacks.",
                "section_checklist": "Provide a delivery verification checklist.",
            },
            "trace_anchors": [{"turn_ref": str(turn.get("endAssistantMessageId") or ""), "quote_or_summary": user_input[:200]}],
        },
    }


def render_analyzer_prompt(template: str, trace: dict[str, Any], pool_summary: dict[str, Any]) -> str:
    return template.replace("{{TRACE_JSON}}", json.dumps(trace, ensure_ascii=False, indent=2)).replace(
        "{{POOL_SUMMARY_JSON}}", json.dumps(pool_summary, ensure_ascii=False, indent=2)
    )


def build_skill_md_content(envelope: dict[str, Any], writer_prompt: str) -> str:
    skill_name = str(envelope.get("skill_name") or "new-skill")
    skill_md = (envelope.get("guide") or {}).get("skill_md") or {}
    if not skill_md:
        for item in (envelope.get("file_guidance") or []):
            if isinstance(item, dict) and str(item.get("path") or item.get("relative_path") or "") == "SKILL.md":
                g = item.get("guidance")
                if isinstance(g, dict):
                    skill_md = {
                        "frontmatter_description": g.get("description", ""),
                        "section_capability": g.get("section_capability", ""),
                        "section_usage": g.get("section_usage", ""),
                        "section_steps": g.get("section_steps", ""),
                        "section_cautions": g.get("section_cautions", ""),
                        "section_checklist": g.get("section_checklist", ""),
                    }
                elif isinstance(g, str):
                    skill_md = {"section_steps": g}
                break

    def normalize_section(value: Any, default_text: str = "none") -> str:
        if isinstance(value, str):
            return value.strip() or default_text
        if isinstance(value, dict):
            action = str(value.get("action") or "").strip().lower()
            guidance = str(value.get("guidance") or "").strip()
            success = str(value.get("success_criteria") or "").strip()
            if action == "none" and not guidance:
                return default_text
            lines = []
            if action:
                lines.append(f"- action: {action}")
            if guidance:
                lines.append(f"- guidance: {guidance}")
            if success:
                lines.append(f"- success_criteria: {success}")
            return "\n".join(lines) if lines else default_text
        return default_text

    frontmatter_raw = skill_md.get("frontmatter_description")
    if isinstance(frontmatter_raw, dict):
        desc = str(frontmatter_raw.get("guidance") or "").strip() or "Add this skill's scenario, inputs, and outputs"
    else:
        desc = normalize_section(frontmatter_raw, "Add this skill's scenario, inputs, and outputs")

    def sec(title: str, value: Any) -> str:
        body = normalize_section(value, "none")
        return f"## {title}\n\n{body}\n"
    return (
        f"---\nname: {skill_name}\ndescription: {desc}\n---\n\n"
        f"> generated by memory-worker python backend (MVP)\n\n"
        f"{sec('Capability', skill_md.get('section_capability'))}\n"
        f"{sec('Usage', skill_md.get('section_usage'))}\n"
        f"{sec('Steps', skill_md.get('section_steps'))}\n"
        f"{sec('Cautions / constraints', skill_md.get('section_cautions'))}\n"
        f"{sec('Delivery checklist', skill_md.get('section_checklist'))}\n"
        "## Writer Prompt Snapshot\n\n```text\n"
        f"{writer_prompt}\n```\n"
    )


def read_source_skill_bundle(root: Path) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    if not root.exists():
        return files
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        try:
            content = p.read_text(encoding="utf-8")
        except Exception:
            continue
        files.append({"relative_path": p.relative_to(root).as_posix(), "content": content})
    return files


def normalize_guidance_actions(suggestion: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    guide = suggestion.get("guide") or {}
    file_guidance = guide.get("file_guidance") or []
    if isinstance(file_guidance, list):
        for item in file_guidance:
            if not isinstance(item, dict):
                continue
            raw_guidance = item.get("guidance")
            guidance = json.dumps(raw_guidance, ensure_ascii=False) if isinstance(raw_guidance, (dict, list)) else str(raw_guidance or "")
            out.append(
                {
                    "relative_path": str(item.get("relative_path") or item.get("path") or ""),
                    "action": str(item.get("action") or item.get("operation") or "none").lower(),
                    "guidance": guidance,
                }
            )

    folders = guide.get("folders") or []
    if isinstance(folders, list):
        for item in folders:
            if not isinstance(item, dict):
                continue
            node_type = str(item.get("node_type") or "folder").lower()
            p = str(item.get("path") or "")
            action = str(item.get("action") or item.get("operation") or "none").lower()
            guidance = str(item.get("guidance") or "")
            if not p:
                continue
            if node_type == "file":
                out.append({"relative_path": p, "action": action, "guidance": guidance})
            else:
                # folder action info is applied separately in writer
                out.append({"relative_path": p.rstrip("/") + "/", "action": action, "guidance": guidance})
    return out


def _normalize_writer_rel_path(raw: str) -> str | None:
    rel = str(raw or "").strip().replace("\\", "/").lstrip("/")
    if not rel or rel in {".", ".."} or ".." in rel.split("/"):
        return None
    return rel


def _delete_path_under_root(root: Path, rel: str) -> bool:
    out = root / rel
    try:
        out.relative_to(root)
    except Exception:
        return False
    if not out.exists():
        return False
    if out.is_dir():
        for p in sorted(out.rglob("*"), reverse=True):
            if p.is_file():
                p.unlink(missing_ok=True)
            elif p.is_dir():
                try:
                    p.rmdir()
                except OSError:
                    pass
        try:
            out.rmdir()
        except OSError:
            return False
    else:
        out.unlink(missing_ok=True)
    return True


def _seed_target_from_source_bundle(
    target_dir: Path,
    source_bundle: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    created: list[dict[str, Any]] = []
    for item in source_bundle:
        if not isinstance(item, dict):
            continue
        rel = _normalize_writer_rel_path(str(item.get("relative_path") or ""))
        content = item.get("content")
        if not rel or not isinstance(content, str):
            continue
        out = target_dir / rel
        if out.exists():
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(content, encoding="utf-8")
        created.append({"path": str(out), "reason": "seeded from source_skill_bundle"})
    return created


def _extract_writer_files_from_model(
    parsed: dict[str, Any] | None,
) -> tuple[list[dict[str, str]], list[str]]:
    """Return (files[{path,content,operation}], deleted_paths) from writer LLM JSON."""
    if not isinstance(parsed, dict):
        return [], []
    files_out: list[dict[str, str]] = []
    deleted: list[str] = []

    raw_files = parsed.get("files")
    if isinstance(raw_files, list):
        for item in raw_files:
            if not isinstance(item, dict):
                continue
            rel = _normalize_writer_rel_path(str(item.get("path") or item.get("relative_path") or ""))
            content = item.get("content")
            op = str(item.get("operation") or item.get("action") or "UPDATE").upper()
            if not rel:
                continue
            if op == "DELETE":
                deleted.append(rel)
                continue
            if isinstance(content, str) and content.strip():
                files_out.append({"path": rel, "content": content, "operation": op or "UPDATE"})

    # Convenience: top-level skill_md string
    skill_md = parsed.get("skill_md") or parsed.get("skillMd")
    if isinstance(skill_md, str) and skill_md.strip():
        if not any(f.get("path") == "SKILL.md" for f in files_out):
            files_out.insert(0, {"path": "SKILL.md", "content": skill_md, "operation": "UPDATE"})

    raw_deleted = parsed.get("deleted")
    if isinstance(raw_deleted, list):
        for item in raw_deleted:
            rel = _normalize_writer_rel_path(str(item or ""))
            if rel:
                deleted.append(rel)

    # Legacy applied_actions with optional content
    applied = parsed.get("applied_actions")
    if isinstance(applied, list):
        for item in applied:
            if not isinstance(item, dict):
                continue
            rel = _normalize_writer_rel_path(str(item.get("path") or ""))
            op = str(item.get("operation") or "").upper()
            content = item.get("content")
            if not rel:
                continue
            if op == "DELETE":
                deleted.append(rel)
            elif isinstance(content, str) and content.strip():
                if not any(f.get("path") == rel for f in files_out):
                    files_out.append({"path": rel, "content": content, "operation": op or "UPDATE"})

    # de-dupe deleted while preserving order
    seen_del: set[str] = set()
    deleted_unique: list[str] = []
    for rel in deleted:
        if rel in seen_del:
            continue
        seen_del.add(rel)
        deleted_unique.append(rel)
    return files_out, deleted_unique


def _apply_writer_files_to_disk(
    target_dir: Path,
    files: list[dict[str, str]],
    deleted: list[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    created: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    for rel in deleted:
        try:
            if _delete_path_under_root(target_dir, rel):
                created.append({"path": str(target_dir / rel), "reason": "deleted by writer content payload"})
        except Exception as e:
            warnings.append({"relative_path": rel, "reason": f"delete failed: {e}"})
    for item in files:
        rel = _normalize_writer_rel_path(str(item.get("path") or ""))
        content = item.get("content")
        if not rel or not isinstance(content, str):
            continue
        if rel.endswith("/"):
            try:
                (target_dir / rel).mkdir(parents=True, exist_ok=True)
                created.append({"path": str(target_dir / rel), "reason": "folder from writer content payload"})
            except Exception as e:
                warnings.append({"relative_path": rel, "reason": f"mkdir failed: {e}"})
            continue
        try:
            out = target_dir / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(content, encoding="utf-8")
            created.append(
                {
                    "path": str(out),
                    "reason": f"written by memory_worker from model ({item.get('operation') or 'UPDATE'})",
                }
            )
        except Exception as e:
            warnings.append({"relative_path": rel, "reason": f"write failed: {e}"})
    return created, warnings


def run_writer(
    suggestion: dict[str, Any],
    writer_prompt: str,
    run_dir: Path,
    log_file: Path,
    directory: str | None = None,
    parent_session_id: str | None = None,
) -> dict[str, Any]:
    """Generate skill content via OpenCode (text only), then persist with memory_worker.

    OpenCode must not write files — worker disk writes feed Skill Panel registration
    through the existing writerResults → register_task_skill_result path.
    """
    operation = str(suggestion.get("operation") or "NONE").upper()
    if operation == "NONE":
        append_log(log_file, "writer.skip", {"reason": "operation=NONE"})
        return {"status": "skipped", "reason": "operation=NONE"}

    skill_name = str(suggestion.get("skill_name") or "").strip()
    if not skill_name:
        return {"status": "failed", "reason": "missing skill_name"}

    target_dir = SKILL_WRITE_ROOT / skill_name
    target_dir.mkdir(parents=True, exist_ok=True)
    append_log(log_file, "writer.target.ready", {"targetDir": str(target_dir), "diskWriter": "memory_worker"})

    source_bundle: list[dict[str, Any]] = []
    source_path_raw = str(suggestion.get("source_skill_absolute_path") or "").strip()
    if operation == "UPDATE":
        if not source_path_raw:
            return {"status": "failed", "reason": "UPDATE requires source_skill_absolute_path"}
        source_root = Path(source_path_raw)
        source_bundle = read_source_skill_bundle(source_root)
        write_json(run_dir / "06a-source-skill-bundle.json", source_bundle)
        append_log(log_file, "writer.source.loaded", {"sourcePath": source_path_raw, "files": len(source_bundle)})
        try:
            same_root = source_root.expanduser().resolve() == target_dir.expanduser().resolve()
        except Exception:
            same_root = False
        if not same_root and source_bundle:
            # Seed copy so UPDATE can start from prior skill when write root differs.
            seeded = _seed_target_from_source_bundle(target_dir, source_bundle)
            if seeded:
                append_log(log_file, "writer.target.seeded", {"count": len(seeded)})

    created_files: list[dict[str, Any]] = []
    write_warnings: list[dict[str, Any]] = []
    writer_session: dict[str, Any] | None = None
    writer_mode_effective = MW_WRITER_MODE
    writer_model_summary: dict[str, Any] = {}
    model_wrote_skill_md = False

    if MW_WRITER_MODE in {"opencode", "opencode_content", "llm"}:
        writer_input = {
            "suggestion": suggestion,
            "source_skill_bundle": source_bundle,
            "target_root": str(target_dir),
            "disk_writer": "memory_worker",
        }
        writer_llm_prompt = (
            f"{writer_prompt}\n\n"
            "重要：不要使用任何工具，不要读写磁盘。"
            "只根据输入生成完整文件内容，输出约定 JSON；"
            "memory_worker 会负责落盘。\n\n"
            f"输入：\n{json.dumps(writer_input, ensure_ascii=False, indent=2)}"
        )
        try:
            llm_out = opencode_generate_text(
                writer_llm_prompt,
                run_dir,
                log_file,
                "06b-writer",
                directory=directory,
                parent_session_id=parent_session_id,
            )
            writer_session = llm_out.get("session") if isinstance(llm_out, dict) else None
            parsed = try_parse_json_object(llm_out.get("rawText", ""))
            write_json(run_dir / "06c-writer-raw.json", llm_out)
            write_json(run_dir / "06d-writer-parsed.json", parsed or {})
            if isinstance(parsed, dict):
                writer_model_summary = parsed
            files_payload, deleted_payload = _extract_writer_files_from_model(parsed if isinstance(parsed, dict) else None)
            if files_payload or deleted_payload:
                applied, warns = _apply_writer_files_to_disk(target_dir, files_payload, deleted_payload)
                created_files.extend(applied)
                write_warnings.extend(warns)
                model_wrote_skill_md = any(
                    str(x.get("path") or "").endswith("SKILL.md") for x in applied
                )
                writer_mode_effective = "opencode_worker_disk"
                append_log(
                    log_file,
                    "writer.disk.apply.ok",
                    {
                        "fileCount": len(files_payload),
                        "deletedCount": len(deleted_payload),
                        "appliedCount": len(applied),
                    },
                )
            else:
                writer_mode_effective = "opencode_fallback_template"
                write_warnings.append(
                    {"relative_path": "", "reason": "opencode returned no writable file contents; using template"}
                )
                append_log(log_file, "writer.opencode.no_files", {"parsedKeys": list((parsed or {}).keys()) if isinstance(parsed, dict) else []})
        except Exception as e:
            writer_mode_effective = "opencode_fallback_template"
            write_warnings.append({"relative_path": "", "reason": f"opencode writer exception: {e}"})
            append_log(log_file, "writer.opencode.failed", {"error": str(e)})

    guidance_actions = normalize_guidance_actions(suggestion)

    skill_md_path = target_dir / "SKILL.md"
    if not model_wrote_skill_md or not skill_md_path.exists():
        if writer_mode_effective in {"opencode", "opencode_content", "llm"}:
            writer_mode_effective = "opencode_fallback_template"
        skill_md = build_skill_md_content(suggestion, writer_prompt)
        skill_md_path.write_text(skill_md, encoding="utf-8")
        created_files.append({"path": str(skill_md_path), "reason": "main skill markdown (memory_worker template)"})
        append_log(log_file, "writer.disk.skill_md.template", {"path": str(skill_md_path)})

    for item in guidance_actions:
        rel = _normalize_writer_rel_path(str(item.get("relative_path") or ""))
        action = str(item.get("action") or "none").lower()
        guidance = str(item.get("guidance") or "")
        if not rel:
            continue
        if action in {"none", "keep"} or rel == "SKILL.md":
            continue
        try:
            out = target_dir / rel
            if action == "delete":
                if _delete_path_under_root(target_dir, rel):
                    created_files.append({"path": str(out), "reason": "deleted by guidance"})
                continue
            if rel.endswith("/"):
                out.mkdir(parents=True, exist_ok=True)
                created_files.append({"path": str(out), "reason": f"folder {action} by guidance"})
                continue
            if action in {"create", "update"} and not out.exists():
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(f"# Auto generated placeholder\n# action: {action}\n\n{guidance}\n", encoding="utf-8")
                created_files.append({"path": str(out), "reason": f"file_guidance action={action}"})
        except Exception as e:
            write_warnings.append({"relative_path": rel, "reason": f"guidance apply failed: {e}"})

    if not skill_md_path.exists():
        return {
            "status": "failed",
            "reason": "SKILL.md missing after worker disk write",
            "mode": writer_mode_effective,
            "operation": operation,
            "skillName": skill_name,
            "targetDir": str(target_dir),
            "warnings": write_warnings,
            "opencodeSession": writer_session or {},
            "writerModelSummary": writer_model_summary,
        }

    provenance = {
        "generatedAt": now_iso(),
        "operation": operation,
        "skill_name": skill_name,
        "source_skill_absolute_path": source_path_raw,
        "created_files": created_files,
        "diskWriter": "memory_worker",
        "writerMode": writer_mode_effective,
    }
    provenance_path = target_dir / "PROVENANCE.json"
    write_json(provenance_path, provenance)
    created_files.append({"path": str(provenance_path), "reason": "provenance"})
    # Shape consumed by register_task_skill_result / Skill Panel:
    # status + skillName + targetDir + operation must remain present.
    return {
        "status": "ok",
        "mode": writer_mode_effective,
        "operation": operation,
        "skillName": skill_name,
        "targetDir": str(target_dir),
        "sourceBundleFileCount": len(source_bundle),
        "createdFiles": created_files,
        "warnings": write_warnings,
        "opencodeSession": writer_session or {},
        "writerModelSummary": writer_model_summary,
        "diskWriter": "memory_worker",
    }


def run_analyzer(
    trace: dict[str, Any],
    pool_summary: dict[str, Any],
    run_dir: Path,
    log_file: Path,
    directory: str | None = None,
    parent_session_id: str | None = None,
) -> dict[str, Any]:
    template = (PROMPT_ROOT / "analyzer_prompt.md").read_text(encoding="utf-8")
    prompt = render_analyzer_prompt(template, trace, pool_summary)
    (run_dir / "03-analyst-prompt.txt").write_text(prompt, encoding="utf-8")
    append_log(log_file, "analyzer.prompt.ready", {"promptPath": str(run_dir / "03-analyst-prompt.txt")})

    if MW_ANALYZER_MODE == "mock":
        suggestion = build_mock_envelope(trace, pool_summary)
        payload = {
            "analysis_summary": "mock analyzer result",
            "skill_suggestions": [suggestion],
        }
        append_log(log_file, "analyzer.mock.used", {"count": 1})
        return {"mode": "mock", "rawText": json.dumps(payload, ensure_ascii=False, indent=2), "analysis": payload}

    llm_out = opencode_generate_text(
        prompt,
        run_dir,
        log_file,
        "03a-analyzer",
        directory=directory,
        parent_session_id=parent_session_id,
        retry_with_new_session=True,
        max_attempts=MW_ANALYZER_SESSION_ATTEMPTS,
    )
    raw_text = llm_out["rawText"]
    parsed_any = try_parse_json_value(raw_text)
    if isinstance(parsed_any, list):
        parsed = {"skill_suggestions": [x for x in parsed_any if isinstance(x, dict)]}
    else:
        parsed = parsed_any if isinstance(parsed_any, dict) else None
    return {"mode": "opencode", **llm_out, "analysis": parsed}


def run_pipeline(trace: dict[str, Any], directory_override: str | None = None, parent_session_id: str | None = None) -> dict[str, Any]:
    run_id = build_run_id(trace)
    run_dir = LOG_ROOT / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    log_file = run_dir / "00-run.log"

    append_log(log_file, "pipeline.start", {"runId": run_id, "skillPipeline": MW_SKILL_PIPELINE})
    write_json(run_dir / "01-trace.json", trace)
    append_log(log_file, "trace.saved", {"tracePath": str(run_dir / "01-trace.json")})

    primary_turn = trace_primary_turn(trace)
    trace_dir = str(
        ((primary_turn.get("session") or trace.get("session") or {}).get("directory") or "")
    ).strip()
    effective_directory = directory_override or trace_dir or OPENCODE_DIRECTORY
    pool_summary = build_pool_summary(Path(effective_directory))
    write_json(run_dir / "02-pool-summary.json", pool_summary)
    append_log(
        log_file,
        "pool_summary.generated",
        {
            "skillCount": len(pool_summary.get("skills") or []),
            "effectiveDirectory": effective_directory,
        },
    )

    if MW_SKILL_PIPELINE in {"skill_evolve", "evolve", "vibetrace-skill"}:
        return _run_skill_evolve_pipeline(
            trace,
            run_id=run_id,
            run_dir=run_dir,
            log_file=log_file,
            effective_directory=effective_directory,
            parent_session_id=parent_session_id,
            pool_summary=pool_summary,
        )

    return _run_legacy_analyzer_writer_pipeline(
        trace,
        run_id=run_id,
        run_dir=run_dir,
        log_file=log_file,
        effective_directory=effective_directory,
        parent_session_id=parent_session_id,
        pool_summary=pool_summary,
    )


def _run_skill_evolve_pipeline(
    trace: dict[str, Any],
    *,
    run_id: str,
    run_dir: Path,
    log_file: Path,
    effective_directory: str,
    parent_session_id: str | None,
    pool_summary: dict[str, Any],
) -> dict[str, Any]:
    try:
        from skill_evolve import run_skill_evolve_pipeline
    except Exception as e:
        append_log(log_file, "skill_evolve.import.failed", {"error": str(e)})
        return {
            "ok": False,
            "runId": run_id,
            "runDir": str(run_dir),
            "error": f"skill_evolve import failed: {e}",
            "engine": "skill_evolve",
        }

    skill_roots = configured_skill_roots(Path(effective_directory))

    def complete_provider(
        prompt: str,
        model: str,
        timeout_sec: int,
        variant: str | None,
        label: str,
    ) -> str:
        # variant/timeout_sec unused on HTTP path; model must be explicit (never OpenCode user config).
        del variant, timeout_sec
        llm_out = opencode_generate_text(
            prompt,
            run_dir,
            log_file,
            label,
            directory=effective_directory,
            parent_session_id=parent_session_id,
            model=(model or "").strip() or MW_DEFAULT_MODEL_REF,
            retry_with_new_session=True,
            max_attempts=MW_ANALYZER_SESSION_ATTEMPTS,
        )
        return str(llm_out.get("rawText") or "")

    result = run_skill_evolve_pipeline(
        trace,
        run_dir=run_dir,
        log_file=log_file,
        skill_roots=skill_roots,
        skill_write_root=SKILL_WRITE_ROOT,
        write_json=write_json,
        append_log=append_log,
        complete_provider=complete_provider,
        directory=effective_directory,
        parent_session_id=parent_session_id,
    )
    # Keep pool summary path consistent for callers / UI debugging.
    if not result.get("poolSummaryPath"):
        result["poolSummaryPath"] = str(run_dir / "02-pool-summary.json")
    result["poolSummary"] = pool_summary
    return result


def _run_legacy_analyzer_writer_pipeline(
    trace: dict[str, Any],
    *,
    run_id: str,
    run_dir: Path,
    log_file: Path,
    effective_directory: str,
    parent_session_id: str | None,
    pool_summary: dict[str, Any],
) -> dict[str, Any]:
    try:
        analyzer_output = run_analyzer(
            trace,
            pool_summary,
            run_dir,
            log_file,
            directory=effective_directory,
            parent_session_id=parent_session_id,
        )
    except Exception as e:
        err = str(e)
        stage = "unknown"
        if "message send failed" in err or "POST /session/" in err:
            stage = "analyzer_send"
        elif "wait for assistant stop" in err:
            stage = "analyzer_wait_stop"
        elif _is_timeout_error(e):
            stage = "analyzer_timeout"
        append_log(
            log_file,
            "analyzer.failed",
            {
                "error": err,
                "stage": stage,
                "messageTimeoutSec": MW_OPENCODE_MESSAGE_TIMEOUT_SEC,
                "waitStopTimeoutSec": MW_ANALYZER_WAIT_PER_ATTEMPT_SEC,
                "maxAttempts": MW_ANALYZER_SESSION_ATTEMPTS,
            },
        )
        return {
            "ok": False,
            "runId": run_id,
            "runDir": str(run_dir),
            "error": f"analyzer failed ({stage}): {e}",
        }
    write_json(run_dir / "04-analyzer-raw.json", analyzer_output)
    analysis = analyzer_output.get("analysis")
    analyzer_session_id = str(((analyzer_output.get("session") or {}).get("id") or ""))
    if not isinstance(analysis, dict):
        append_log(log_file, "analyzer.parse.failed", {"message": "no valid envelope"})
        return {
            "ok": False,
            "runId": run_id,
            "runDir": str(run_dir),
            "error": "Analyzer output parse failed",
            "analyzerOutput": analyzer_output,
        }

    suggestions_raw = analysis.get("skill_suggestions")
    if not isinstance(suggestions_raw, list):
        # backward compatibility: if analyzer produced old single-envelope shape
        if isinstance(analysis.get("guide"), dict):
            suggestions_raw = [analysis]
        else:
            append_log(log_file, "analyzer.parse.failed", {"message": "analysis missing skill_suggestions"})
            return {
                "ok": False,
                "runId": run_id,
                "runDir": str(run_dir),
                "error": "Analyzer output missing skill_suggestions",
                "analyzerOutput": analyzer_output,
            }

    suggestions: list[dict[str, Any]] = [x for x in suggestions_raw if isinstance(x, dict)]
    write_json(run_dir / "05-skill-suggestions.json", {"skill_suggestions": suggestions, "analysis_summary": analysis.get("analysis_summary", "")})

    actionable_suggestions: list[tuple[int, dict[str, Any]]] = []
    for idx, suggestion in enumerate(suggestions):
        operation = str(suggestion.get("operation") or "NONE").upper()
        if operation != "NONE":
            actionable_suggestions.append((idx, suggestion))

    writer_results: list[dict[str, Any]] = []
    if not actionable_suggestions:
        append_log(
            log_file,
            "writer.skip_all",
            {"reason": "no CREATE/UPDATE suggestions", "suggestionCount": len(suggestions)},
        )
        write_json(
            run_dir / "07-writer-result.json",
            {"results": [], "skipped": True, "reason": "no actionable suggestions"},
        )
    else:
        writer_prompt = (PROMPT_ROOT / "writer_prompt.md").read_text(encoding="utf-8")
        (run_dir / "06-writer-prompt.txt").write_text(writer_prompt, encoding="utf-8")
        for idx, suggestion in actionable_suggestions:
            try:
                one = run_writer(
                    suggestion,
                    writer_prompt,
                    run_dir,
                    log_file,
                    directory=effective_directory,
                    parent_session_id=analyzer_session_id or parent_session_id,
                )
            except Exception as e:
                append_log(log_file, "writer.failed", {"error": str(e), "suggestionIndex": idx})
                one = {"status": "failed", "reason": str(e)}
            writer_results.append({"index": idx, "suggestion": suggestion, "result": one})
        write_json(run_dir / "07-writer-result.json", {"results": writer_results})

    final_operation = "NONE"
    final_skill_name = ""
    if suggestions:
        final_operation = str(suggestions[0].get("operation") or "NONE")
        final_skill_name = str(suggestions[0].get("skill_name") or "")

    overall_writer_status = "ok"
    for item in writer_results:
        st = str(((item.get("result") or {}).get("status") or "ok"))
        if st in {"failed"}:
            overall_writer_status = "failed"
            break
    summary = {
        "runId": run_id,
        "operation": final_operation,
        "analyzerMode": analyzer_output.get("mode"),
        "writerMode": MW_WRITER_MODE,
        "writerStatus": overall_writer_status,
        "skillName": final_skill_name,
        "suggestionCount": len(suggestions),
        "generatedAt": now_iso(),
        "effectiveDirectory": effective_directory,
        "parentSessionID": parent_session_id or "",
        "analyzerSessionID": analyzer_session_id,
        "writerSessionID": "",
        "engine": "legacy",
    }
    writer_session_id = ""
    for item in writer_results:
        r = item.get("result") or {}
        if isinstance(r, dict):
            sid = str(((r.get("opencodeSession") or {}).get("id") or ""))
            if sid:
                writer_session_id = sid
                break
    summary["writerSessionID"] = writer_session_id
    write_summary(run_dir, summary)
    append_log(log_file, "pipeline.done", summary)

    return {
        "ok": True,
        "runId": run_id,
        "runDir": str(run_dir),
        "tracePath": str(run_dir / "01-trace.json"),
        "poolSummaryPath": str(run_dir / "02-pool-summary.json"),
        "suggestionsPath": str(run_dir / "05-skill-suggestions.json"),
        "writerResultPath": str(run_dir / "07-writer-result.json"),
        "analyzerOutput": analyzer_output,
        "analysis": analysis,
        "writerResults": writer_results,
        "analyzerSessionID": analyzer_session_id,
        "writerSessionID": writer_session_id,
        "engine": "legacy",
    }


# Per-workspace folder for always-on behavior reports (hand this folder back to researchers).
EXPERIMENT_BEHAVIOR_DIRNAME = "vibetrace-behavior"


def save_experiment_report(body: dict[str, Any]) -> dict[str, Any]:
    """Write an experiment report JSON into {workspace}/vibetrace-behavior/.

    Expected body: { directory: str, report: object, filename?: str }
    """
    directory = str(body.get("directory") or "").strip()
    report = body.get("report")
    if not directory:
        return {"ok": False, "error": "directory is required"}
    if report is None:
        return {"ok": False, "error": "report is required"}

    root = Path(directory).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        return {"ok": False, "error": f"directory does not exist or is not a folder: {root}"}

    out_dir = root / EXPERIMENT_BEHAVIOR_DIRNAME
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return {"ok": False, "error": f"failed to create behavior folder: {e}"}

    raw_name = str(body.get("filename") or "").strip()
    if not raw_name:
        participant = ""
        if isinstance(report, dict):
            participant = str(report.get("participantId") or "").strip()
        safe_pid = re.sub(r"[^\w.-]+", "_", participant) or "participant"
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        raw_name = f"vibetrace-experiment-{safe_pid}-{stamp}.json"
    # Prevent path traversal — filename only
    filename = Path(raw_name).name
    if not filename.endswith(".json"):
        filename = f"{filename}.json"
    if ".." in filename or "/" in filename or "\\" in filename:
        return {"ok": False, "error": "invalid filename"}

    target = out_dir / filename
    try:
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError as e:
        return {"ok": False, "error": f"failed to write report: {e}"}

    print(f"[memory-worker] experiment-report saved path={target}")
    return {
        "ok": True,
        "path": str(target),
        "filename": filename,
        "folder": EXPERIMENT_BEHAVIOR_DIRNAME,
    }


class AppHandler(BaseHTTPRequestHandler):
    server_version = "memory-worker-py/0.1"

    def _set_common_headers(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin and origin in MW_CORS_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

    def _send_json(self, status: int, body: dict[str, Any]) -> None:
        """Write a JSON response. Client disconnect mid-write is logged, not raised.

        Long /ingest-trace handlers (sync error-diagnosis) often outlive the browser
        or Vite proxy; the work may already be done when BrokenPipe happens.
        """
        payload = json.dumps(body, ensure_ascii=False, indent=2).encode("utf-8")
        try:
            self.send_response(status)
            self._set_common_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as e:
            print(
                f"[memory-worker] client disconnected while sending HTTP {status} "
                f"({type(e).__name__}); response body dropped"
            )

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length).decode("utf-8", errors="replace") if length > 0 else "{}"
        return json.loads(raw) if raw.strip() else {}

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._set_common_headers()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "memory-worker-python",
                    "opencodeBase": OPENCODE_BASE,
                    "opencodeDirectory": OPENCODE_DIRECTORY,
                    "skillWriteRoot": str(SKILL_WRITE_ROOT),
                    "analyzerMode": MW_ANALYZER_MODE,
                    "skillPipeline": MW_SKILL_PIPELINE,
                    "taskSwitchMode": MW_TASK_SWITCH_MODE,
                    "taskSwitchContract": "segments.v1",
                    "taskSwitchStatePath": str(TASK_SWITCH_STATE_PATH),
                    "taskSwitchStateExists": TASK_SWITCH_STATE_PATH.exists(),
                    "skillLoadRoots": [str(x) for x in configured_skill_roots(Path(OPENCODE_DIRECTORY))],
                },
            )
            return
        if parsed.path == "/task-skills":
            qs = parse_qs(parsed.query)
            session_id = str((qs.get("sessionId") or [""])[0]).strip()
            task_id = str((qs.get("taskId") or [""])[0]).strip()
            directory = str((qs.get("directory") or [""])[0]).strip() or None
            if not session_id or not task_id:
                self._send_json(400, {"ok": False, "error": "sessionId and taskId are required"})
                return
            self._send_json(200, task_skills_response_for_directory(session_id, task_id, directory))
            return
        if parsed.path == "/task-skill-detail":
            qs = parse_qs(parsed.query)
            session_id = str((qs.get("sessionId") or [""])[0]).strip()
            task_id = str((qs.get("taskId") or [""])[0]).strip()
            skill_key = str((qs.get("skillKey") or [""])[0]).strip()
            if not session_id or not task_id or not skill_key:
                self._send_json(400, {"ok": False, "error": "sessionId, taskId and skillKey are required"})
                return
            result = task_skill_detail_response(session_id, task_id, skill_key)
            self._send_json(200 if result.get("ok") else 404, result)
            return
        if parsed.path == "/panel-analysis":
            qs = parse_qs(parsed.query)
            session_id = str((qs.get("sessionId") or [""])[0]).strip()
            if not session_id:
                self._send_json(400, {"ok": False, "error": "sessionId is required"})
                return
            self._send_json(200, panel_analysis_for_session(session_id))
            return
        if parsed.path == "/task-segments":
            qs = parse_qs(parsed.query)
            session_id = str((qs.get("sessionId") or [""])[0]).strip()
            if not session_id:
                self._send_json(400, {"ok": False, "error": "sessionId is required"})
                return
            self._send_json(200, task_segments_for_session(session_id))
            return
        self._send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/panel-analysis":
            try:
                body = self._read_json()
                session_id = str(body.get("sessionId") or "").strip() if isinstance(body, dict) else ""
                subtask_id = str(body.get("subtaskId") or "").strip() if isinstance(body, dict) else ""
                directory_override = str(body.get("directory") or "").strip() or None if isinstance(body, dict) else None
                parent_session_id = str(body.get("parentSessionID") or "").strip() or None if isinstance(body, dict) else None
                if not session_id or not subtask_id:
                    self._send_json(400, {"ok": False, "error": "sessionId and subtaskId are required", "count": 0, "items": []})
                    return
                print(
                    "[memory-worker] panel-analysis "
                    f"sessionId={session_id} subtaskId={subtask_id} directory={directory_override or ''}"
                )
                messages = opencode_get_messages(session_id, directory=directory_override)
                result = run_panel_analysis_for_subtask(
                    messages=messages,
                    session_id=session_id,
                    subtask_id=subtask_id,
                    directory_override=directory_override,
                    parent_session_id=parent_session_id,
                )
                self._send_json(200 if result.get("ok") else 400, result)
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e), "count": 0, "items": []})
            return

        if self.path == "/task-feedback-distill":
            try:
                body = self._read_json()
                result = distill_feedback_skill(body)
                self._send_json(200 if result.get("ok") else 400, result)
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        if self.path == "/experiment-report":
            try:
                body = self._read_json()
                result = save_experiment_report(body if isinstance(body, dict) else {})
                self._send_json(200 if result.get("ok") else 400, result)
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        if self.path == "/task-skill-save":
            try:
                body = self._read_json()
                result = save_task_skill_md(body if isinstance(body, dict) else {})
                self._send_json(200 if result.get("ok") else 400, result)
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        if self.path == "/fork-inherit-task-state":
            try:
                body = self._read_json()
                result = inherit_fork_task_state(body if isinstance(body, dict) else {})
                self._send_json(200 if result.get("ok") else 400, result)
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        if self.path == "/task-switch-prompt":
            try:
                body = self._read_json()
                session_id = str(body.get("sessionId") or "").strip() if isinstance(body, dict) else ""
                user_prompt = str(body.get("userPrompt") or "").strip() if isinstance(body, dict) else ""
                directory_override = str(body.get("directory") or "").strip() or None if isinstance(body, dict) else None
                parent_session_id = str(body.get("parentSessionID") or "").strip() or None if isinstance(body, dict) else None
                fork_meta = body.get("forkMeta") if isinstance(body, dict) and isinstance(body.get("forkMeta"), dict) else None
                print(
                    "[memory-worker] task-switch.prompt "
                    f"sessionId={session_id} promptLen={len(user_prompt)} "
                    f"taskSwitchMode={MW_TASK_SWITCH_MODE} directory={directory_override or ''} fork={bool(fork_meta)}"
                )
                messages = opencode_get_messages(session_id, directory=directory_override)
                result = process_user_prompt_task_switch(
                    messages=messages,
                    session_id=session_id,
                    user_prompt=user_prompt,
                    directory_override=directory_override,
                    parent_session_id=parent_session_id,
                    fork_meta=fork_meta,
                )
                self._send_json(200 if result.get("ok") else 400, result)
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
            return

        if self.path != "/ingest-trace":
            self._send_json(404, {"ok": False, "error": "Not found"})
            return
        try:
            body = self._read_json()
            if isinstance(body, dict) and body.get("sessionId") and body.get("endAssistantMessageId"):
                session_id = str(body.get("sessionId") or "").strip()
                end_msg_id = str(body.get("endAssistantMessageId") or "").strip()
                directory_override = str(body.get("directory") or "").strip() or None
                parent_session_id = str(body.get("parentSessionID") or "").strip() or None
                fork_meta = body.get("forkMeta") if isinstance(body.get("forkMeta"), dict) else None

                print(
                    "[memory-worker] ingest.ref "
                    f"sessionId={session_id} endAssistantMessageId={end_msg_id} "
                    f"taskSwitchMode={MW_TASK_SWITCH_MODE} directory={directory_override or ''} fork={bool(fork_meta)}"
                )

                messages = opencode_get_messages(session_id, directory=directory_override)
                try:
                    result = process_reference_ingest_with_task_switch(
                        messages=messages,
                        session_id=session_id,
                        end_msg_id=end_msg_id,
                        directory_override=directory_override,
                        parent_session_id=parent_session_id,
                        fork_meta=fork_meta,
                    )
                except Exception as inner:
                    result = {"ok": False, "error": str(inner)}
                self._send_json(200, result)
                return

            trace = trace_parser.normalize_trace_payload(body) or normalize_trace_payload(body)
            if not trace:
                self._send_json(
                    400,
                    {
                        "ok": False,
                        "error": "Invalid payload. Send either {sessionId, endAssistantMessageId} or a full trace (trace.v1 / trace.session.v1).",
                    },
                )
                return
            directory_override = str(body.get("directory") or "").strip() if isinstance(body, dict) else ""
            parent_session_id = str(body.get("parentSessionID") or "").strip() if isinstance(body, dict) else ""
            try:
                result = run_pipeline_with_dedup(
                    trace,
                    directory_override=directory_override or None,
                    parent_session_id=parent_session_id or None,
                )
            except Exception as inner:
                result = {"ok": False, "error": str(inner)}
            self._send_json(200, result)
        except Exception as e:
            self._send_json(500, {"ok": False, "error": str(e)})


@dataclass
class StartupConfig:
    port: int
    opencode_base: str
    opencode_directory: str
    skill_write_root: str
    analyzer_mode: str
    task_switch_mode: str
    writer_mode: str
    session_strategy: str


def startup_config() -> StartupConfig:
    return StartupConfig(
        port=PORT,
        opencode_base=OPENCODE_BASE,
        opencode_directory=OPENCODE_DIRECTORY,
        skill_write_root=str(SKILL_WRITE_ROOT),
        analyzer_mode=MW_ANALYZER_MODE,
        task_switch_mode=MW_TASK_SWITCH_MODE,
        writer_mode=MW_WRITER_MODE,
        session_strategy=MW_SESSION_STRATEGY,
    )


def main() -> None:
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    ensure_prompt_files()
    cfg = startup_config()
    print(f"[memory-worker] listening on http://127.0.0.1:{cfg.port}")
    print(f"[memory-worker] OPENCODE_BASE={cfg.opencode_base}")
    print(f"[memory-worker] OPENCODE_DIRECTORY={cfg.opencode_directory}")
    print(f"[memory-worker] SKILL_WRITE_ROOT={cfg.skill_write_root}")
    print(f"[memory-worker] MW_ANALYZER_MODE={cfg.analyzer_mode}")
    print(f"[memory-worker] MW_TASK_SWITCH_MODE={cfg.task_switch_mode}")
    print(f"[memory-worker] MW_OPENCODE_HTTP_TIMEOUT_SEC={MW_OPENCODE_HTTP_TIMEOUT_SEC}")
    print(f"[memory-worker] MW_OPENCODE_MESSAGE_TIMEOUT_SEC={MW_OPENCODE_MESSAGE_TIMEOUT_SEC}")
    print(f"[memory-worker] MW_ANALYZER_WAIT_PER_ATTEMPT_SEC={MW_ANALYZER_WAIT_PER_ATTEMPT_SEC}")
    print(f"[memory-worker] MW_ANALYZER_SESSION_ATTEMPTS={MW_ANALYZER_SESSION_ATTEMPTS}")
    print(f"[memory-worker] MW_DEFAULT_MODEL_REF={MW_DEFAULT_MODEL_REF}")
    print(f"[memory-worker] MW_WRITER_MODE={cfg.writer_mode}")
    print(f"[memory-worker] MW_SESSION_STRATEGY={cfg.session_strategy}")
    auth_on = bool(opencode_basic_auth_header())
    print(f"[memory-worker] OPENCODE_AUTH={'basic' if auth_on else 'none'}")
    server = ThreadingHTTPServer(("127.0.0.1", cfg.port), AppHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()

