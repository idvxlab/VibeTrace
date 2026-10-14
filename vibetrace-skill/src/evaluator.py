from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from .config import Config
from .trace import Trace


class Evaluator:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._backend = os.environ.get("SE_EVAL_BACKEND") or cfg.get(
            "evaluator.backend", "docker"
        )
        self._crun = None

    def evaluate(
        self, traces: list[Trace], instances: dict[str, dict], tag: str
    ) -> dict:
        if self._backend == "crun":
            return self._evaluate_crun(traces, instances, tag)
        return self._evaluate_docker(traces, tag)

    def _evaluate_crun(self, traces, instances, tag) -> dict:
        from .crun_backend import CrunBackend

        if self._crun is None:
            self._crun = CrunBackend(self.cfg)
        resolved_ids: list[str] = []
        ungraded: list[str] = []
        jobs = [(t, instances.get(t.instance_id)) for t in traces]
        rootfs_errors: dict[str, str] = {}
        for t, inst in jobs:
            if inst is not None:
                try:
                    self._crun.ensure_rootfs(t.instance_id)
                except Exception as ex:
                    rootfs_errors[t.instance_id] = str(ex)
        def grade_one(t: Trace, inst: dict | None) -> tuple[Trace, bool, str | None]:
            if inst is None:
                return t, False, None
            if t.instance_id in rootfs_errors:
                return t, False, rootfs_errors[t.instance_id]
            try:
                # Each SWE-bench instance has its own mutable rootfs, so
                # different instances from the same repository are independent.
                ok = self._crun.grade(inst, t.diff or "")
                return t, bool(ok), None
            except Exception as ex:
                return t, False, str(ex)

        workers = max(1, int(self.cfg.get("evaluator.max_workers", 1)))
        if workers <= 1 or len(jobs) <= 1:
            graded = [grade_one(t, inst) for t, inst in jobs]
        else:
            with ThreadPoolExecutor(max_workers=min(workers, len(jobs))) as ex:
                futures = [ex.submit(grade_one, t, inst) for t, inst in jobs]
                graded = [f.result() for f in as_completed(futures)]

        for t, ok, err in graded:
            t.resolved = ok
            if ok:
                resolved_ids.append(t.instance_id)
            if err:
                ungraded.append(t.instance_id)
                if not t.error:
                    t.error = f"grading failed (crun): {err}"
        return {
            "backend": "crun",
            "tag": tag,
            "total": len(traces),
            "resolved": len(resolved_ids),
            "resolved_ids": sorted(resolved_ids),
            "ungraded_ids": sorted(ungraded),
        }

    def _evaluate_docker(self, traces, tag) -> dict:
        model_name = "vibetrace"
        with tempfile.TemporaryDirectory(prefix="se_eval_") as tmp:
            preds_path = Path(tmp) / "preds.jsonl"
            with open(preds_path, "w", encoding="utf-8") as f:
                for t in traces:
                    f.write(
                        json.dumps(
                            {
                                "instance_id": t.instance_id,
                                "model_name_or_path": model_name,
                                "model_patch": t.diff or "",
                            }
                        )
                        + "\n"
                    )

            dataset_name = self.cfg.get("dataset.name")

            run_id = f"{self.cfg.get('evaluator.run_id_prefix','skillevolve')}-{tag}"
            cmd = [
                sys.executable,
                "-m",
                "swebench.harness.run_evaluation",
                "--dataset_name",
                dataset_name,
                "--predictions_path",
                str(preds_path),
                "--max_workers",
                str(self.cfg.get("evaluator.max_workers", 4)),
                "--run_id",
                run_id,
                "--cache_level",
                "env",
            ]

            try:
                proc = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd=tmp,
                    timeout=int(self.cfg.get("evaluator.timeout_sec", 3600)),
                )
            except subprocess.TimeoutExpired as ex:
                proc = ex
            report = self._find_report(Path(tmp), model_name, run_id)

            if report is None:
                report = self._find_report(Path.cwd(), model_name, run_id)

            stdout = proc.stdout or ""
            stderr = proc.stderr or ""
            if isinstance(stdout, bytes):
                stdout = stdout.decode(errors="replace")
            if isinstance(stderr, bytes):
                stderr = stderr.decode(errors="replace")

        if report is None:
            tail = (stderr or stdout or "")[-1500:]
            rc = getattr(proc, "returncode", "timeout")
            raise RuntimeError(
                f"swebench harness produced no report for tag={tag} (rc={rc}); "
                f"cannot grade — check docker / image build / network. Output tail:\n{tail}"
            )

        resolved_set = self._ids_from_report(
            report, ("resolved_ids", "resolved_instances", "resolved")
        )
        graded_set = self._ids_from_report(
            report, ("completed_ids", "completed_instances")
        )
        empty_set = self._ids_from_report(
            report, ("empty_patch_ids", "empty_patch_instances")
        )
        ungraded: list[str] = []
        for t in traces:
            iid = t.instance_id
            if iid in resolved_set:
                t.resolved = True
            elif iid in graded_set:
                t.resolved = False
            elif (t.diff or "").strip() and iid not in empty_set:
                t.resolved = False
                ungraded.append(iid)
                if not t.error:
                    t.error = "grading failed (no harness verdict)"
            else:
                t.resolved = False
        return {
            "backend": "docker",
            "tag": tag,
            "total": len(traces),
            "resolved": len(resolved_set),
            "resolved_ids": sorted(resolved_set),
            "ungraded_ids": sorted(ungraded),
            "harness_report": report,
            "harness_stderr_tail": stderr[-800:],
        }

    @staticmethod
    def _ids_from_report(report: dict | None, keys: tuple[str, ...]) -> set[str]:
        if not report:
            return set()
        for key in keys:
            val = report.get(key)
            if isinstance(val, list) and (not val or isinstance(val[0], str)):
                return set(val)
        return set()

    @staticmethod
    def _find_report(root: Path, model_name: str, run_id: str) -> dict | None:
        candidates = [
            *root.glob(f"{model_name}.{run_id}.json"),
            *root.glob(f"*{run_id}*.json"),
        ]
        for c in candidates:
            try:
                return json.loads(c.read_text(encoding="utf-8"))
            except Exception:
                continue
        return None
