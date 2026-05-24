from __future__ import annotations

import base64
import json
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import uuid4
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parent.parent
LOG_ROOT = REPO_ROOT / "memory_worker" / "logs"
PROMPT_ROOT = REPO_ROOT / "memory_worker" / "prompts"
INGEST_DEDUP_INDEX = LOG_ROOT / "ingest-dedup-index.json"
INGEST_DEDUP_STALE_RUNNING_SEC = 900
_ingest_dedup_lock = threading.Lock()


def load_env_file(path: Path) -> None:
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
        if k not in os.environ:
            os.environ[k] = v.strip()


load_env_file(REPO_ROOT / ".env.local")
load_env_file(REPO_ROOT / ".env")

OPENCODE_BASE = (os.environ.get("OPENCODE_BASE") or os.environ.get("VITE_OPENCODE_BASE") or "http://127.0.0.1:4096").rstrip("/")
OPENCODE_DIRECTORY = os.environ.get("OPENCODE_DIRECTORY") or str(REPO_ROOT)
SKILL_WRITE_ROOT = Path(os.environ.get("SKILL_WRITE_ROOT") or (Path.home() / ".claude" / "skills"))
MW_ANALYZER_MODE = (os.environ.get("MW_ANALYZER_MODE") or "opencode").strip().lower()
MW_WRITER_MODE = (os.environ.get("MW_WRITER_MODE") or "opencode").strip().lower()
MW_SESSION_STRATEGY = (os.environ.get("MW_SESSION_STRATEGY") or "new").strip().lower()
MW_SESSION_TITLE_PREFIX = (os.environ.get("MW_SESSION_TITLE_PREFIX") or "[mw-internal]").strip()
MW_CORS_ORIGINS = [x.strip() for x in (os.environ.get("MW_CORS_ORIGINS") or "http://localhost:5173;http://127.0.0.1:5173").split(";") if x.strip()]
MW_ANALYZER_SESSION_ATTEMPTS = max(1, int(os.environ.get("MW_ANALYZER_SESSION_ATTEMPTS") or "5"))
INGEST_DEDUP_FAILED_COOLDOWN_SEC = max(60, int(os.environ.get("INGEST_DEDUP_FAILED_COOLDOWN_SEC") or "600"))

# OpenCode HTTP 超时（代码内常量，不走 env）
MW_OPENCODE_HTTP_TIMEOUT_SEC = 60
MW_OPENCODE_MESSAGE_TIMEOUT_SEC = 180
MW_ANALYZER_WAIT_PER_ATTEMPT_SEC = 180

ANALYZER_IN_SESSION_RETRY_PROMPT = (
    "The previous reply did not complete within the time limit. Continue in this same session: "
    "finish the skill analysis and output the full JSON envelope only (skill_suggestions array), "
    "with no extra prose before or after the JSON."
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
                "你是 SkillAnalyzer（Judge）。请根据 trace 与 pool_summary 输出唯一 JSON，禁止任何解释性文字。\n\n"
                "要求：\n"
                "1) operation 只能是 CREATE / UPDATE / NONE\n"
                "2) NONE: skill_name='' 且 source_skill_absolute_path=''\n"
                "3) UPDATE: source_skill_absolute_path 必须非空且来自 pool_summary\n"
                "4) guide 要包含 folders、file_guidance、skill_md、trace_anchors\n\n"
                "输出 schema：SkillJudgeEnvelope v2.0。\n\n"
                "trace:\n{{TRACE_JSON}}\n\n"
                "pool_summary:\n{{POOL_SUMMARY_JSON}}\n"
            ),
            encoding="utf-8",
        )
    if not writer.exists():
        writer.write_text(
            (
                "你是 SkillWriter。\n"
                "- CREATE: 在 SKILL_WRITE_ROOT/<skill_name>/ 新建技能目录\n"
                "- UPDATE: 先读取 source_skill_bundle 再改写\n"
                "- NONE: 跳过\n"
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
    roots = [
        project_dir / ".opencode" / "skills",
        Path.home() / ".config" / "opencode" / "skills",
        project_dir / ".claude" / "skills",
        Path.home() / ".claude" / "skills",
        project_dir / ".agents" / "skills",
        Path.home() / ".agents" / "skills",
    ]
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
        # fork 失败时回退 new session
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


def opencode_send_message(session_id: str, text: str, directory: str | None = None) -> None:
    body = {"parts": [{"type": "text", "text": text}]}
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
    retry_in_session_on_timeout: bool = False,
    max_attempts: int | None = None,
    retry_prompt: str | None = None,
) -> dict[str, Any]:
    attempts_limit = max_attempts if max_attempts is not None else (MW_ANALYZER_SESSION_ATTEMPTS if retry_in_session_on_timeout else 1)
    continue_prompt = (retry_prompt or ANALYZER_IN_SESSION_RETRY_PROMPT).strip()

    append_log(log_file, f"{phase}.session.create.start", {})
    session = opencode_create_session(
        directory=directory,
        parent_session_id=parent_session_id,
        internal_label=phase,
    )
    write_json(run_dir / f"{phase}-session.json", session)
    session_id = str(session.get("id") or "")
    append_log(
        log_file,
        f"{phase}.session.create.ok",
        {
            "sessionID": session_id,
            "directory": directory or OPENCODE_DIRECTORY,
            "parentSessionID": parent_session_id or "",
            "maxAttempts": attempts_limit,
            "messageTimeoutSec": MW_OPENCODE_MESSAGE_TIMEOUT_SEC,
            "waitStopTimeoutSec": MW_ANALYZER_WAIT_PER_ATTEMPT_SEC,
        },
    )

    last_timeout: RuntimeError | None = None
    assistant: dict[str, Any] | None = None

    for attempt in range(1, attempts_limit + 1):
        before_ids = _assistant_message_ids(opencode_get_messages(session_id, directory=directory))
        user_text = prompt if attempt == 1 else continue_prompt
        append_log(
            log_file,
            f"{phase}.attempt.start",
            {"attempt": attempt, "maxAttempts": attempts_limit, "isRetry": attempt > 1},
        )
        try:
            opencode_send_message(session_id, user_text, directory=directory)
        except RuntimeError as e:
            append_log(
                log_file,
                f"{phase}.message.send.failed",
                {
                    "sessionID": session_id,
                    "attempt": attempt,
                    "error": str(e),
                    "messageTimeoutSec": MW_OPENCODE_MESSAGE_TIMEOUT_SEC,
                },
            )
            raise RuntimeError(
                f"{phase} message send failed (HTTP wait up to {MW_OPENCODE_MESSAGE_TIMEOUT_SEC}s): {e}"
            ) from e
        append_log(log_file, f"{phase}.message.send.ok", {"sessionID": session_id, "attempt": attempt})
        try:
            assistant = wait_assistant_stop_message(session_id, before_ids, directory=directory)
            append_log(log_file, f"{phase}.wait.stop.ok", {"sessionID": session_id, "attempt": attempt})
            break
        except RuntimeError as e:
            if "timeout" not in str(e).lower():
                raise
            last_timeout = e
            append_log(
                log_file,
                f"{phase}.wait.timeout",
                {
                    "sessionID": session_id,
                    "attempt": attempt,
                    "waitStopTimeoutSec": MW_ANALYZER_WAIT_PER_ATTEMPT_SEC,
                    "willRetryInSession": retry_in_session_on_timeout and attempt < attempts_limit,
                },
            )
            if not retry_in_session_on_timeout or attempt >= attempts_limit:
                raise RuntimeError(
                    f"{phase} wait for assistant stop timed out after {MW_ANALYZER_WAIT_PER_ATTEMPT_SEC}s "
                    f"({attempts_limit} attempt(s) exhausted)"
                ) from e

    if assistant is None:
        raise last_timeout or RuntimeError("timeout waiting assistant stop message")

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
    """Align with cockpit-ui `isAssistantStopMessage` (info.finish or step-finish reason=stop)."""
    info = message.get("info") or {}
    if info.get("role") != "assistant":
        return False
    if info.get("finish") == "stop":
        return True
    nested = message.get("message")
    if isinstance(nested, dict) and nested.get("finish") == "stop":
        return True
    parts = message.get("parts")
    if isinstance(parts, list):
        for part in parts:
            if (
                isinstance(part, dict)
                and part.get("type") == "step-finish"
                and part.get("reason") == "stop"
            ):
                return True
    return False


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
        rationale = "命中现有 skill，先走 UPDATE。"
    else:
        operation = "CREATE"
        skill_name = "auto-generated-skill"
        source_path = ""
        rationale = "未发现现有 skill，先 CREATE。"
    if len(user_input.strip()) < 2:
        operation = "NONE"
        skill_name = ""
        source_path = ""
        rationale = "输入信息不足，暂不生成。"
    return {
        "schema_version": "2.0",
        "run_id": run_id,
        "operation": operation,
        "skill_name": skill_name,
        "source_skill_absolute_path": source_path,
        "rationale": rationale,
        "guide": {
            "overall": "MVP mock envelope，后续替换为真实 analyzer 输出。",
            "folders": {
                "skill_root_layout": "保持标准目录结构",
                "scripts": "none",
                "reference": "none",
                "data": "none",
                "other": "none",
            },
            "file_guidance": [{"relative_path": "SKILL.md", "action": "update" if operation == "UPDATE" else "create", "guidance": "补全能力、使用方式、步骤、约束、checklist。"}],
            "skill_md": {
                "frontmatter_description": "这个 skill 用于将 trace 分析结果转为可复用流程。",
                "section_capability": "解释该 skill 的能力边界。",
                "section_usage": "给出触发条件、输入输出。",
                "section_steps": "列出分步执行方式。",
                "section_cautions": "说明风险和失败兜底。",
                "section_checklist": "给出交付校验清单。",
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
        desc = str(frontmatter_raw.get("guidance") or "").strip() or "请补充该 skill 的场景与输入输出"
    else:
        desc = normalize_section(frontmatter_raw, "请补充该 skill 的场景与输入输出")

    def sec(title: str, value: Any) -> str:
        body = normalize_section(value, "none")
        return f"## {title}\n\n{body}\n"
    return (
        f"---\nname: {skill_name}\ndescription: {desc}\n---\n\n"
        f"> generated by memory-worker python backend (MVP)\n\n"
        f"{sec('能力说明', skill_md.get('section_capability'))}\n"
        f"{sec('使用方式', skill_md.get('section_usage'))}\n"
        f"{sec('步骤流程', skill_md.get('section_steps'))}\n"
        f"{sec('注意事项 / 约束', skill_md.get('section_cautions'))}\n"
        f"{sec('交付标准 / checklist', skill_md.get('section_checklist'))}\n"
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


def run_writer(
    suggestion: dict[str, Any],
    writer_prompt: str,
    run_dir: Path,
    log_file: Path,
    directory: str | None = None,
    parent_session_id: str | None = None,
) -> dict[str, Any]:
    operation = str(suggestion.get("operation") or "NONE").upper()
    if operation == "NONE":
        append_log(log_file, "writer.skip", {"reason": "operation=NONE"})
        return {"status": "skipped", "reason": "operation=NONE"}

    skill_name = str(suggestion.get("skill_name") or "").strip()
    if not skill_name:
        return {"status": "failed", "reason": "missing skill_name"}

    target_dir = SKILL_WRITE_ROOT / skill_name
    target_dir.mkdir(parents=True, exist_ok=True)
    append_log(log_file, "writer.target.ready", {"targetDir": str(target_dir)})

    source_bundle: list[dict[str, Any]] = []
    source_path_raw = str(suggestion.get("source_skill_absolute_path") or "").strip()
    if operation == "UPDATE":
        if not source_path_raw:
            return {"status": "failed", "reason": "UPDATE requires source_skill_absolute_path"}
        source_root = Path(source_path_raw)
        source_bundle = read_source_skill_bundle(source_root)
        write_json(run_dir / "06a-source-skill-bundle.json", source_bundle)
        append_log(log_file, "writer.source.loaded", {"sourcePath": source_path_raw, "files": len(source_bundle)})
    created_files: list[dict[str, Any]] = []
    write_warnings: list[dict[str, Any]] = []
    writer_session: dict[str, Any] | None = None

    writer_mode_effective = MW_WRITER_MODE
    writer_model_summary: dict[str, Any] = {}
    if MW_WRITER_MODE == "opencode":
        writer_input = {
            "suggestion": suggestion,
            "source_skill_bundle": source_bundle,
            "target_root": str(target_dir),
        }
        writer_llm_prompt = (
            f"{writer_prompt}\n\n"
            "现在开始执行真实改动。只能在 target_root 下操作。完成后输出约定 JSON。\n\n"
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

            # collect file tree after agent action as observable write result
            for p in target_dir.rglob("*"):
                if p.is_file():
                    created_files.append({"path": str(p), "reason": "writer agent output (observed)"})
        except Exception as e:
            writer_mode_effective = "opencode_fallback_template"
            write_warnings.append({"relative_path": "", "reason": f"opencode writer exception: {e}"})
            append_log(log_file, "writer.opencode.failed", {"error": str(e)})

    guidance_actions = normalize_guidance_actions(suggestion)

    if not created_files:
        if writer_mode_effective == "opencode":
            writer_mode_effective = "opencode_fallback_template"
        skill_md = build_skill_md_content(suggestion, writer_prompt)
        skill_md_path = target_dir / "SKILL.md"
        skill_md_path.write_text(skill_md, encoding="utf-8")
        created_files = [{"path": str(skill_md_path), "reason": "main skill markdown"}]

    for item in guidance_actions:
        rel = str(item.get("relative_path") or "").strip().replace("\\", "/").lstrip("/")
        action = str(item.get("action") or "none").lower()
        guidance = str(item.get("guidance") or "")
        if not rel or rel in {".", ".."} or ".." in rel.split("/"):
            continue
        if action in {"none", "keep"} or rel == "SKILL.md":
            continue
        try:
            out = target_dir / rel
            if action == "delete":
                if out.exists():
                    if out.is_dir():
                        for p in sorted(out.rglob("*"), reverse=True):
                            if p.is_file():
                                p.unlink(missing_ok=True)
                            elif p.is_dir():
                                p.rmdir()
                        out.rmdir()
                    else:
                        out.unlink(missing_ok=True)
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

    provenance = {
        "generatedAt": now_iso(),
        "operation": operation,
        "skill_name": skill_name,
        "source_skill_absolute_path": source_path_raw,
        "created_files": created_files,
    }
    provenance_path = target_dir / "PROVENANCE.json"
    write_json(provenance_path, provenance)
    created_files.append({"path": str(provenance_path), "reason": "provenance"})
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
        retry_in_session_on_timeout=True,
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

    append_log(log_file, "pipeline.start", {"runId": run_id})
    write_json(run_dir / "01-trace.json", trace)
    append_log(log_file, "trace.saved", {"tracePath": str(run_dir / "01-trace.json")})

    primary_turn = trace_primary_turn(trace)
    trace_dir = str(
        ((primary_turn.get("session") or trace.get("session") or {}).get("directory") or "")
    ).strip()
    effective_directory = directory_override or trace_dir or OPENCODE_DIRECTORY
    pool_summary = build_pool_summary(Path(effective_directory))
    write_json(run_dir / "02-pool-summary.json", pool_summary)
    append_log(log_file, "pool_summary.generated", {"skillCount": len(pool_summary.get("skills") or []), "effectiveDirectory": effective_directory})

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
        payload = json.dumps(body, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self._set_common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length).decode("utf-8", errors="replace") if length > 0 else "{}"
        return json.loads(raw) if raw.strip() else {}

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._set_common_headers()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "memory-worker-python",
                    "opencodeBase": OPENCODE_BASE,
                    "opencodeDirectory": OPENCODE_DIRECTORY,
                    "skillWriteRoot": str(SKILL_WRITE_ROOT),
                    "analyzerMode": MW_ANALYZER_MODE,
                },
            )
            return
        self._send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/ingest-trace":
            self._send_json(404, {"ok": False, "error": "Not found"})
            return
        try:
            body = self._read_json()
            trace = normalize_trace_payload(body)
            if not trace:
                self._send_json(
                    400,
                    {
                        "ok": False,
                        "error": "Invalid payload, expected trace.v1, trace.session.v1, or {trace: ...}",
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
    writer_mode: str
    session_strategy: str


def startup_config() -> StartupConfig:
    return StartupConfig(
        port=PORT,
        opencode_base=OPENCODE_BASE,
        opencode_directory=OPENCODE_DIRECTORY,
        skill_write_root=str(SKILL_WRITE_ROOT),
        analyzer_mode=MW_ANALYZER_MODE,
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
    print(f"[memory-worker] MW_OPENCODE_HTTP_TIMEOUT_SEC={MW_OPENCODE_HTTP_TIMEOUT_SEC}")
    print(f"[memory-worker] MW_OPENCODE_MESSAGE_TIMEOUT_SEC={MW_OPENCODE_MESSAGE_TIMEOUT_SEC}")
    print(f"[memory-worker] MW_ANALYZER_WAIT_PER_ATTEMPT_SEC={MW_ANALYZER_WAIT_PER_ATTEMPT_SEC}")
    print(f"[memory-worker] MW_ANALYZER_SESSION_ATTEMPTS={MW_ANALYZER_SESSION_ATTEMPTS}")
    print(f"[memory-worker] MW_WRITER_MODE={cfg.writer_mode}")
    print(f"[memory-worker] MW_SESSION_STRATEGY={cfg.session_strategy}")
    auth_on = bool(opencode_basic_auth_header())
    print(f"[memory-worker] OPENCODE_AUTH={'basic' if auth_on else 'none'}")
    server = ThreadingHTTPServer(("127.0.0.1", cfg.port), AppHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()

