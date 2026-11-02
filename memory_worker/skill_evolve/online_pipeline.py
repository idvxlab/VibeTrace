from __future__ import annotations

import json
import logging
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from .config import Config
from .distiller import SkillDistiller
from .estimator import TraceEstimator
from .llm import reset_complete_label, reset_complete_provider, set_complete_label, set_complete_provider
from .online_adapter import (
    AppliedDiskChange,
    apply_pool_to_disk,
    load_pool_from_roots,
    online_trace_to_evidence,
)
from .skillpool import Patch, PatchOp, SkillPool

log = logging.getLogger("memory_worker.skill_evolve")

CompleteProvider = Callable[[str, str, int, Optional[str], str], str]
WriteJsonFn = Callable[[Path, Any], None]
AppendLogFn = Callable[[Path, str, dict], None]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _op_to_frontend(op: str) -> str:
    mapping = {
        "create": "CREATE",
        "revise": "UPDATE",
        "merge": "CREATE",
        "remove": "DELETE",
    }
    return mapping.get(op, "UPDATE")


def _suggestion_from_change(
    change: AppliedDiskChange,
    *,
    scored: list[tuple[PatchOp, float]] | None = None,
) -> dict[str, Any]:
    rationale = change.rationale
    if scored:
        for op, score in scored:
            if op.op == change.op or (
                change.op in {"create", "merge"} and op.op in {"create", "merge"} and op.name == change.skill_name
            ):
                dims = getattr(op, "score_dims", None) or {}
                rationale = (
                    f"{change.rationale} (score={score:.3f}"
                    + (f", dims={json.dumps(dims, ensure_ascii=False)}" if dims else "")
                    + ")"
                )
                break
    return {
        "operation": change.frontend_operation,
        "skill_name": change.skill_name,
        "source_skill_absolute_path": change.skill_path if change.frontend_operation == "UPDATE" else "",
        "rationale": rationale,
        "file_guidance": [
            {
                "path": "SKILL.md",
                "operation": change.frontend_operation,
                "reason": change.rationale,
                "summary": change.rationale,
            }
        ],
        "trace_anchors": [],
        "engine": "skill_evolve",
        "patch_op": change.op,
        "skill_id": change.skill_id,
    }


def _writer_result_from_change(change: AppliedDiskChange) -> dict[str, Any]:
    status = "ok"
    return {
        "status": status,
        "mode": "skill_evolve",
        "operation": change.frontend_operation,
        "skillName": change.skill_name,
        "targetDir": change.skill_path,
        "createdFiles": (
            [{"path": str(Path(change.skill_path) / "SKILL.md"), "reason": f"skill_evolve {change.op}"}]
            if change.skill_path and change.frontend_operation != "DELETE"
            else []
        ),
        "warnings": [],
        "removedPaths": change.removed_paths,
        "engine": "skill_evolve",
        "patchOp": change.op,
        "skillId": change.skill_id,
    }


def run_skill_evolve_pipeline(
    trace: dict[str, Any],
    *,
    run_dir: Path,
    log_file: Path,
    skill_roots: list[Path],
    skill_write_root: Path,
    write_json: WriteJsonFn,
    append_log: AppendLogFn,
    complete_provider: CompleteProvider | None = None,
    config_overrides: dict[str, Any] | None = None,
    directory: str | None = None,
    parent_session_id: str | None = None,
) -> dict[str, Any]:
    """
    One-shot online distill:
      online trace → Evidence → estimator gate → distill → score → apply → disk
    """
    run_dir.mkdir(parents=True, exist_ok=True)
    append_log(log_file, "skill_evolve.start", {"runDir": str(run_dir), "engine": "skill_evolve"})

    cfg = Config.load(config_overrides)
    score_threshold = float(cfg.get("distiller.score_threshold", 0.10))

    provider_token = None
    if complete_provider is not None:
        provider_token = set_complete_provider(complete_provider)

    try:
        evidence = online_trace_to_evidence(trace)
        write_json(
            run_dir / "03-skill-evolve-evidence.json",
            {
                "kind": evidence.kind,
                "instance": evidence.instance,
                "primary": evidence.primary.slim(role="primary"),
                "negative": evidence.negative.slim(role="negative") if evidence.negative else None,
            },
        )
        append_log(
            log_file,
            "skill_evolve.evidence.ready",
            {
                "kind": evidence.kind,
                "instanceId": evidence.instance.get("instance_id"),
                "actionCount": evidence.primary.n_actions,
                "resolved": evidence.primary.resolved,
            },
        )

        pool, meta = load_pool_from_roots(skill_roots)
        pool_before = SkillPool.from_dict(pool.to_dict())
        write_json(
            run_dir / "02b-skill-evolve-pool.json",
            {
                "roots": [str(p) for p in skill_roots],
                "writeRoot": str(skill_write_root),
                "pool": pool.to_dict(),
                "idToPath": {k: str(v) for k, v in meta.id_to_path.items()},
            },
        )
        append_log(log_file, "skill_evolve.pool.loaded", {"skillCount": len(pool)})

        estimator = TraceEstimator(cfg)
        label_tok = set_complete_label("03a-estimator")
        try:
            est = estimator.estimate(evidence)
        finally:
            reset_complete_label(label_tok)

        write_json(
            run_dir / "04-skill-evolve-estimator.json",
            {"passed": est.passed, "components": est.components},
        )
        append_log(
            log_file,
            "skill_evolve.estimator.done",
            {"passed": est.passed, "components": est.components},
        )

        candidates: list[PatchOp] = []
        scored: list[tuple[PatchOp, float]] = []
        accepted_ops: list[PatchOp] = []
        applied_msgs: list[str] = []
        changes: list[AppliedDiskChange] = []

        if not est.passed:
            append_log(log_file, "skill_evolve.skip", {"reason": "estimator_gate_failed"})
        else:
            distiller = SkillDistiller(cfg)
            label_tok = set_complete_label("05a-distiller")
            try:
                candidates = distiller.distill(evidence, pool)
            finally:
                reset_complete_label(label_tok)

            write_json(
                run_dir / "05-skill-evolve-candidates.json",
                {"candidates": [asdict(op) for op in candidates]},
            )
            append_log(log_file, "skill_evolve.distill.done", {"candidateCount": len(candidates)})

            if candidates:
                label_tok = set_complete_label("05b-scorer")
                try:
                    scored = distiller.score_candidates(candidates, evidence, pool)
                finally:
                    reset_complete_label(label_tok)

                write_json(
                    run_dir / "05c-skill-evolve-scores.json",
                    {
                        "threshold": score_threshold,
                        "scores": [
                            {
                                **asdict(op),
                                "score": round(s, 4),
                                "score_dims": getattr(op, "score_dims", None),
                            }
                            for op, s in scored
                        ],
                    },
                )
                accepted_ops = [op for op, s in scored if s >= score_threshold][: distiller.K]
                append_log(
                    log_file,
                    "skill_evolve.score.done",
                    {
                        "accepted": len(accepted_ops),
                        "threshold": score_threshold,
                        "best": max((s for _, s in scored), default=0.0),
                    },
                )

                if accepted_ops:
                    applied_msgs = pool.apply(Patch(ops=accepted_ops), round_idx=0)
                    changes = apply_pool_to_disk(
                        pool_before,
                        pool,
                        meta,
                        write_root=skill_write_root,
                        applied_msgs=applied_msgs,
                        accepted_ops=accepted_ops,
                    )
                    write_json(
                        run_dir / "06-skill-evolve-applied.json",
                        {
                            "applied": applied_msgs,
                            "changes": [
                                {
                                    "op": c.op,
                                    "skillId": c.skill_id,
                                    "skillName": c.skill_name,
                                    "skillPath": c.skill_path,
                                    "frontendOperation": c.frontend_operation,
                                    "rationale": c.rationale,
                                    "removedPaths": c.removed_paths,
                                }
                                for c in changes
                            ],
                            "poolAfter": pool.to_dict(),
                        },
                    )
                    append_log(
                        log_file,
                        "skill_evolve.apply.done",
                        {"applied": applied_msgs, "changeCount": len(changes)},
                    )
                else:
                    append_log(log_file, "skill_evolve.skip", {"reason": "no_candidates_above_threshold"})
            else:
                append_log(log_file, "skill_evolve.skip", {"reason": "no_candidates"})

        suggestions = [_suggestion_from_change(c, scored=scored) for c in changes]
        writer_results = [
            {
                "index": i,
                "suggestion": _suggestion_from_change(c, scored=scored),
                "result": _writer_result_from_change(c),
            }
            for i, c in enumerate(changes)
        ]

        analysis = {
            "analysis_summary": (
                f"skill_evolve engine: estimator_passed={est.passed}, "
                f"candidates={len(candidates)}, accepted={len(accepted_ops)}, applied={len(changes)}"
            ),
            "skill_suggestions": suggestions
            or [
                {
                    "operation": "NONE",
                    "skill_name": "",
                    "source_skill_absolute_path": "",
                    "rationale": (
                        "estimator gate failed"
                        if not est.passed
                        else "no accepted skill patches"
                    ),
                    "engine": "skill_evolve",
                }
            ],
            "engine": "skill_evolve",
            "estimator": {"passed": est.passed, "components": est.components},
            "candidateCount": len(candidates),
            "acceptedCount": len(accepted_ops),
        }
        write_json(
            run_dir / "05-skill-suggestions.json",
            {
                "skill_suggestions": analysis["skill_suggestions"],
                "analysis_summary": analysis["analysis_summary"],
                "engine": "skill_evolve",
            },
        )
        write_json(
            run_dir / "07-writer-result.json",
            {
                "results": writer_results,
                "skipped": not writer_results,
                "reason": None if writer_results else "no accepted skill_evolve patches",
                "engine": "skill_evolve",
            },
        )

        final_operation = "NONE"
        final_skill_name = ""
        if suggestions:
            final_operation = str(suggestions[0].get("operation") or "NONE")
            final_skill_name = str(suggestions[0].get("skill_name") or "")

        summary = {
            "runId": run_dir.name,
            "operation": final_operation,
            "analyzerMode": "skill_evolve",
            "writerMode": "skill_evolve",
            "writerStatus": "ok",
            "skillName": final_skill_name,
            "suggestionCount": len(suggestions),
            "generatedAt": _now_iso(),
            "effectiveDirectory": directory or "",
            "parentSessionID": parent_session_id or "",
            "analyzerSessionID": "",
            "writerSessionID": "",
            "engine": "skill_evolve",
            "estimatorPassed": est.passed,
            "candidateCount": len(candidates),
            "acceptedCount": len(accepted_ops),
            "appliedCount": len(changes),
        }
        write_json(run_dir / "00-summary.json", summary)
        append_log(log_file, "skill_evolve.done", summary)

        return {
            "ok": True,
            "runId": run_dir.name,
            "runDir": str(run_dir),
            "tracePath": str(run_dir / "01-trace.json"),
            "poolSummaryPath": str(run_dir / "02-pool-summary.json"),
            "suggestionsPath": str(run_dir / "05-skill-suggestions.json"),
            "writerResultPath": str(run_dir / "07-writer-result.json"),
            "analyzerOutput": {
                "mode": "skill_evolve",
                "rawText": json.dumps(analysis, ensure_ascii=False),
                "analysis": analysis,
            },
            "analysis": analysis,
            "writerResults": writer_results,
            "analyzerSessionID": "",
            "writerSessionID": "",
            "engine": "skill_evolve",
            "skillEvolve": {
                "estimator": {"passed": est.passed, "components": est.components},
                "candidates": [asdict(op) for op in candidates],
                "accepted": [asdict(op) for op in accepted_ops],
                "applied": applied_msgs,
                "changes": [
                    {
                        "op": c.op,
                        "skillId": c.skill_id,
                        "skillName": c.skill_name,
                        "skillPath": c.skill_path,
                        "frontendOperation": c.frontend_operation,
                    }
                    for c in changes
                ],
            },
        }
    except Exception as e:
        append_log(log_file, "skill_evolve.failed", {"error": str(e)})
        write_json(run_dir / "07-writer-result.json", {"results": [], "error": str(e), "engine": "skill_evolve"})
        return {
            "ok": False,
            "runId": run_dir.name,
            "runDir": str(run_dir),
            "error": f"skill_evolve failed: {e}",
            "engine": "skill_evolve",
        }
    finally:
        if provider_token is not None:
            reset_complete_provider(provider_token)
