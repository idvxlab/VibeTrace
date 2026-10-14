from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path

from .config import Config
from .llm import apply_rotating_keys
from .prompt_loader import load_prompt, render_template
from .skillpool import SkillPool
from .trace import Trace, parse_opencode_events

log = logging.getLogger("vibetrace.runner")


@dataclass
class OpenCodeRunner:
    cfg: Config

    @property
    def model(self) -> str:
        m = self.cfg.get("opencode.model")
        return m[0] if isinstance(m, list) else m

    @property
    def variant(self):
        return self.cfg.get("opencode.variant")

    @property
    def timeout(self) -> int:
        return int(self.cfg.get("opencode.timeout_sec", 900))

    @property
    def max_attempts(self) -> int:
        return max(1, int(self.cfg.get("opencode.max_attempts", 2)))

    def _timeout_for(self, instance: dict) -> int:
        by_diff = self.cfg.get("opencode.timeout_by_difficulty", {}) or {}
        diff = instance.get("difficulty", "")
        if diff and diff in by_diff:
            return int(by_diff[diff])
        return self.timeout

    def _repo_cache(self, repo: str) -> Path:
        repos_dir_cfg = self.cfg.get("dataset.repos_dir")
        if repos_dir_cfg:
            repos_root = self.cfg.resolve("dataset.repos_dir")
        else:
            repos_root = self.cfg.resolve("dataset.cache_dir") / "repos"
        repos_root.mkdir(parents=True, exist_ok=True)

        name = repo.replace("/", "__")
        bare = repos_root / (name + ".git")
        if bare.exists():
            return bare
        return repos_root / name

    def ensure_repo_cache(self, repo: str) -> Path:
        cache = self._repo_cache(repo)
        if not cache.exists():
            repos_dir_cfg = self.cfg.get("dataset.repos_dir")
            hint_dir = repos_dir_cfg or f"{self.cfg.get('dataset.cache_dir')}/repos"
            raise FileNotFoundError(
                f"repo mirror not found: {cache}. Make sure {repo} is cloned under "
                f"{hint_dir}/ (as <name>.git bare mirror or <name>/ non-bare clone)."
            )
        return cache

    def _ws_name(self, instance: dict, run_id: str | None) -> str:
        base = instance["instance_id"]
        return f"{base}__{run_id}" if run_id else base

    def prepare_workspace(self, instance: dict, run_id: str | None = None) -> Path:
        repo = instance["repo"]
        base_commit = instance["base_commit"]
        cache = self.ensure_repo_cache(repo)

        ws_root = self.cfg.resolve("run.workspace_dir")
        ws_root.mkdir(parents=True, exist_ok=True)
        ws = ws_root / self._ws_name(instance, run_id)
        if ws.exists():
            shutil.rmtree(ws)
        subprocess.run(
            ["git", "clone", str(cache), str(ws)],
            check=True,
            capture_output=True,
            text=True,
            timeout=600,
        )
        subprocess.run(
            ["git", "-C", str(ws), "checkout", "-f", base_commit],
            check=True,
            capture_output=True,
            text=True,
            timeout=300,
        )
        subprocess.run(
            ["git", "-C", str(ws), "clean", "-fdx"],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
        )
        return ws

    def _build_prompt(self, instance: dict, ws: Path | None = None) -> str:
        location = str(ws) if ws else "the current directory"
        return render_template(
            load_prompt("task_prompt.md", self.cfg),
            {"LOCATION": location, "PROBLEM_STATEMENT": instance["problem_statement"]},
        )

    def _opencode_state_root(self) -> Path:
        configured = self.cfg.get("opencode.state_dir")
        if configured:
            return self.cfg.resolve("opencode.state_dir")
        return self.cfg.resolve("run.workspace_dir") / ".opencode_state"

    def _task_runtime_root(self, ws: Path) -> Path:
        return self._opencode_state_root() / ws.name

    @staticmethod
    def _venv_bin_dir(root: Path) -> Path:
        return root / ("Scripts" if os.name == "nt" else "bin")

    def _ensure_task_python_env(
        self, ws: Path, creation_env: dict[str, str] | None = None
    ) -> Path | None:
        """Create a private Python environment for commands run by one task.

        The experiment harness itself runs inside its own venv. Passing that venv
        through to coding tasks lets commands such as ``pip install -e .`` write
        task-specific ``.pth`` and editable-install metadata into the harness,
        contaminating every concurrent and later task. Keep the task environment
        beside its isolated OpenCode state so it is outside the git workspace and
        is removed by ``cleanup_ws``.
        """
        if not self.cfg.get("opencode.isolate_python_env", True):
            return None

        root = self._task_runtime_root(ws) / "python-env"
        python = self._venv_bin_dir(root) / (
            "python.exe" if os.name == "nt" else "python"
        )
        if python.exists():
            return root

        root.parent.mkdir(parents=True, exist_ok=True)
        if root.exists():
            shutil.rmtree(root)
        base_executable = Path(getattr(sys, "_base_executable", "") or "")
        creator = (
            base_executable if base_executable.is_file() else Path(sys.executable)
        )
        cmd = [str(creator), "-m", "venv"]
        if self.cfg.get("opencode.python_env_system_site_packages", True):
            cmd.append("--system-site-packages")
        cmd.append(str(root))
        try:
            subprocess.run(
                cmd,
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
                env=creation_env,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            shutil.rmtree(root, ignore_errors=True)
            detail = getattr(exc, "stderr", "") or str(exc)
            raise RuntimeError(
                f"failed to create isolated Python environment for {ws.name}: "
                f"{detail[:400]}"
            ) from exc
        return root

    @staticmethod
    def _without_path_entries(path: str, blocked: set[Path]) -> str:
        blocked_resolved = {
            os.path.normcase(os.path.realpath(str(entry))) for entry in blocked
        }
        kept = []
        for entry in path.split(os.pathsep):
            if not entry:
                continue
            resolved = os.path.normcase(os.path.realpath(entry))
            if resolved not in blocked_resolved:
                kept.append(entry)
        return os.pathsep.join(kept)

    def _opencode_xdg_dirs(self, ws: Path | None) -> dict[str, Path]:
        if not ws or not self.cfg.get("opencode.isolate_state", True):
            return {}
        root = self._task_runtime_root(ws)
        return {
            "XDG_DATA_HOME": root / "data",
            "XDG_STATE_HOME": root / "state",
            "XDG_CACHE_HOME": root / "cache",
        }

    def _run_env(self, ws: Path | None = None) -> dict:
        env = os.environ.copy()
        parent_virtual_env = env.get("VIRTUAL_ENV")
        blocked_bins = {self._venv_bin_dir(Path(sys.prefix))}
        if parent_virtual_env:
            blocked_bins.add(self._venv_bin_dir(Path(parent_virtual_env)))

        for key in (
            "PYTHONPATH",
            "PYTHONHOME",
            "PYTHONSTARTUP",
            "PYTHONUSERBASE",
            "CONDA_PREFIX",
            "CONDA_DEFAULT_ENV",
            "PIP_PREFIX",
            "PIP_TARGET",
            "UV_PROJECT_ENVIRONMENT",
        ):
            env.pop(key, None)
        env.pop("VIRTUAL_ENV", None)
        env["PATH"] = self._without_path_entries(env.get("PATH", ""), blocked_bins)
        env["PYTHONNOUSERSITE"] = "1"

        python_env = self._ensure_task_python_env(ws, env) if ws else None
        if python_env is not None:
            task_bin = self._venv_bin_dir(python_env)
            env["VIRTUAL_ENV"] = str(python_env)
            env["PATH"] = os.pathsep.join(
                entry for entry in (str(task_bin), env["PATH"]) if entry
            )
            # Keep both pip and uv installs inside the per-task environment.
            env["PIP_REQUIRE_VIRTUALENV"] = "1"
            env["PIP_USER"] = "0"
            env["UV_PROJECT_ENVIRONMENT"] = str(python_env)
        else:
            env.pop("VIRTUAL_ENV", None)

        if self.cfg.get("opencode.disable_external_skills", True):
            env["OPENCODE_DISABLE_EXTERNAL_SKILLS"] = "1"
            env["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"] = "1"
        for key, path in self._opencode_xdg_dirs(ws).items():
            path.mkdir(parents=True, exist_ok=True)
            env[key] = str(path)
        return apply_rotating_keys(env)

    def _run_opencode(
        self, ws: Path, prompt: str, timeout: int, extra: list[str] | None = None
    ) -> tuple[list[dict], str | None]:
        opencode = shutil.which("opencode") or "opencode"
        cmd = [
            opencode,
            "run",
            "--format",
            "json",
            "-m",
            self.model,
            "--dir",
            str(ws),
        ]
        if self.variant:
            cmd += ["--variant", self.variant]
        if self.cfg.get("opencode.skip_permissions", True):
            cmd.append("--dangerously-skip-permissions")
        cmd += list(self.cfg.get("opencode.extra_args", []) or [])
        if extra:
            cmd += extra
        cmd.append(prompt)

        events: list[dict] = []
        err: str | None = None
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=str(ws),
                env=self._run_env(ws),
            )
            events = self._parse_event_lines(proc.stdout)
            if proc.returncode != 0:
                err = f"opencode rc={proc.returncode}: {proc.stderr[:400]}"
        except subprocess.TimeoutExpired as exc:
            out = exc.stdout
            if isinstance(out, bytes):
                out = out.decode("utf-8", errors="replace")
            events = self._parse_event_lines(out or "")
            err = f"timeout after {timeout}s"
        return events, err

    @staticmethod
    def _parse_event_lines(stdout: str) -> list[dict]:
        events: list[dict] = []
        for line in stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return events

    def _build_trace(
        self,
        events: list[dict],
        err: str | None,
        instance: dict,
        ws: Path,
    ) -> Trace:
        trace = parse_opencode_events(events, instance["instance_id"])
        trace.difficulty = instance.get("difficulty", "")
        trace.error = err
        trace.diff = self._extract_diff(ws)
        trace.feedback["workspace"] = str(ws)
        return trace

    def _extract_diff(self, ws: Path) -> str:
        subprocess.run(
            ["git", "-C", str(ws), "add", "-A", "--", ".", ":!.opencode"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        proc = subprocess.run(
            ["git", "-C", str(ws), "diff", "--cached", "--", ".", ":!.opencode"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return proc.stdout

    def run_task(
        self,
        instance: dict,
        pool: SkillPool,
        run_id: str | None = None,
        cleanup: bool = False,
    ) -> Trace:
        timeout = self._timeout_for(instance)
        max_attempts = self.max_attempts
        last: Trace | None = None
        for attempt in range(1, max_attempts + 1):
            attempt_id = (
                run_id
                if (run_id and max_attempts == 1)
                else (
                    f"{run_id}-a{attempt}"
                    if run_id
                    else f"a{attempt}-{uuid.uuid4().hex[:6]}"
                )
            )
            ws = self.prepare_workspace(instance, run_id=attempt_id)
            pool.materialize_skills(ws)
            prompt = self._build_prompt(instance, ws)

            events, err = self._run_opencode(ws, prompt, timeout)
            trace = self._build_trace(events, err, instance, ws)
            if self.cfg.get("opencode.isolate_state", True):
                trace.feedback["opencode_state"] = str(
                    self._opencode_state_root() / ws.name
                )
            if self.cfg.get("opencode.isolate_python_env", True):
                trace.feedback["python_env"] = str(
                    self._task_runtime_root(ws) / "python-env"
                )

            if (
                trace.error is None
                and trace.n_actions == 0
                and not (trace.diff or "").strip()
            ):
                trace.error = "no-op run (0 tool calls, empty diff)"

            last = trace
            if trace.error is None:
                break
            if attempt < max_attempts:
                log.warning(
                    "[%s] attempt %d/%d failed (%s); retrying",
                    instance["instance_id"],
                    attempt,
                    max_attempts,
                    trace.error,
                )

                self.cleanup_ws(ws)

        if cleanup and last is not None:
            self.cleanup_ws(Path(last.feedback.get("workspace", "")))
        return last

    def cleanup_ws(self, ws: Path) -> None:
        if not ws or not ws.name:
            return
        try:
            if ws.exists():
                shutil.rmtree(ws)
            if self.cfg.get(
                "opencode.isolate_state", True
            ) or self.cfg.get("opencode.isolate_python_env", True):
                state_dir = self._task_runtime_root(ws)
                if state_dir.exists():
                    shutil.rmtree(state_dir)
        except OSError:
            pass

    def fork_run(
        self,
        instance: dict,
        base_trace: Trace,
        pool: SkillPool,
        hint: str,
    ) -> Trace:
        ws = Path(base_trace.feedback.get("workspace", ""))
        if not ws.exists():
            ws = self.prepare_workspace(instance, run_id=f"fork-{uuid.uuid4().hex[:6]}")
            pool.materialize_skills(ws)

        fork_prompt = render_template(
            load_prompt("fork_prompt.md", self.cfg), {"HINT": hint}
        )

        extra = (
            ["--session", base_trace.session_id, "--fork"]
            if base_trace.session_id
            else None
        )
        events, err = self._run_opencode(
            ws, fork_prompt, self._timeout_for(instance), extra=extra
        )
        trace = self._build_trace(events, err, instance, ws)
        trace.feedback["fork_prompt"] = fork_prompt
        trace.feedback["fork_hint"] = hint
        return trace
