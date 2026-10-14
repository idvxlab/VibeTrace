from __future__ import annotations

import json
import logging
import uuid
from dataclasses import asdict
from pathlib import Path

from . import dataset, feedback
from .budget import BudgetTable
from .config import Config
from .constants import DISTILL_SETTINGS, SETTINGS
from .distiller import SkillDistiller
from .estimator import TraceEstimator
from .evaluate import (
    _TABLE_COLS,
    _difficulty_tables,
    _metric_console,
    _metric_table,
    build_train_report,
    load_train_reports,
    write_json,
)
from .evaluator import Evaluator
from .evidence import Evidence, build_pair, build_single
from .objective import usd_cost
from .opencode_runner import OpenCodeRunner
from .skillpool import Patch, SkillPool
from .trace import Trace, skill_use_label

log = logging.getLogger("vibetrace.distill")

_DEFAULT_FAILURE_FEEDBACK = (
    "Locate the root cause more carefully and make a minimal, correct fix; "
    "avoid unrelated, broad changes."
)
_DEFAULT_SUCCESS_FEEDBACK = (
    "I've reviewed the result; the requested behavior is resolved."
)
_FIXED_FEEDBACK_POLICY = "fixed-outcome-v1"


def _feedback_policy(setting: str) -> str:
    return _FIXED_FEEDBACK_POLICY if setting == "trace-fb" else "none"


def _out_dir(cfg: Config) -> Path:
    d = cfg.resolve("run.output_dir") / "distill"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _distill_checkpoint(
    setting: str,
    instance_ids: list[str],
    model: str,
    variant: str | None,
    next_round: int,
    pool: SkillPool,
    rounds_log: list[dict],
    cand_log: list[dict],
    seen: list[Trace],
    slim_traces: list[dict],
    *,
    complete: bool,
) -> dict:
    return {
        "schema_version": 1,
        "kind": "distillation",
        "setting": setting,
        "feedback_policy": _feedback_policy(setting),
        "instance_ids": instance_ids,
        "model": model,
        "variant": variant,
        "next_round": next_round,
        "complete": complete,
        "pool": pool.to_dict(),
        "rounds": rounds_log,
        "candidates": cand_log,
        "seen": [t.slim(round=i, role="observed") for i, t in enumerate(seen)],
        "traces": slim_traces,
    }


def _load_distill_checkpoint(
    path: Path,
    setting: str,
    instance_ids: list[str],
    model: str,
    variant: str | None,
) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if (
        data.get("schema_version") != 1
        or data.get("kind") != "distillation"
        or data.get("setting") != setting
        or data.get("feedback_policy") != _feedback_policy(setting)
        or data.get("instance_ids") != instance_ids
        or data.get("model") != model
        or data.get("variant") != variant
    ):
        raise ValueError(
            f"incompatible distillation checkpoint: {path}; "
            "setting, feedback policy, model, or dataset order changed"
        )
    next_round = int(data.get("next_round", 0))
    if not 0 <= next_round <= len(instance_ids):
        raise ValueError(f"invalid next_round={next_round} in {path}")
    return data


def run_distillation(cfg: Config, setting: str) -> SkillPool:
    assert setting in DISTILL_SETTINGS, setting
    use_feedback = setting == "trace-fb"

    distill, _ = dataset.split(cfg)
    instances = {x["instance_id"]: x for x in distill}

    budgets = BudgetTable.from_config(cfg)
    score_threshold = float(cfg.get("distiller.score_threshold", 0.10))

    runner = OpenCodeRunner(cfg)
    estimator = TraceEstimator(cfg)
    distiller = SkillDistiller(cfg)
    evaluator = Evaluator(cfg)

    out = _out_dir(cfg)
    checkpoint_path = out / f"checkpoint_{setting}.json"
    instance_ids = [x["instance_id"] for x in distill]
    resume = bool(cfg.get("run.resume", False))

    if resume and checkpoint_path.exists():
        checkpoint = _load_distill_checkpoint(
            checkpoint_path, setting, instance_ids, runner.model, runner.variant
        )
        pool = SkillPool.from_dict(checkpoint.get("pool") or {})
        rounds_log = list(checkpoint.get("rounds") or [])
        cand_log = list(checkpoint.get("candidates") or [])
        seen = [
            Trace.from_dict(item)
            for item in (checkpoint.get("seen") or [])
            if isinstance(item, dict)
        ]
        slim_traces = list(checkpoint.get("traces") or [])
        start_round = int(checkpoint.get("next_round", 0))
        if len(rounds_log) != start_round or len(seen) != start_round:
            raise ValueError(
                f"incomplete checkpoint state in {checkpoint_path}: "
                f"next_round={start_round}, rounds={len(rounds_log)}, seen={len(seen)}"
            )
        log.info(
            "[%s] resume from %s: next round %d/%d, |Ω|=%d",
            setting,
            checkpoint_path,
            start_round + 1 if start_round < len(distill) else start_round,
            len(distill),
            len(pool),
        )
        if checkpoint.get("complete") and start_round == len(distill):
            log.info("[%s] checkpoint already complete; skipping distillation", setting)
            return pool
    else:
        pool = SkillPool()
        rounds_log = []
        cand_log = []
        seen = []
        slim_traces = []
        start_round = 0
        write_json(
            checkpoint_path,
            _distill_checkpoint(
                setting,
                instance_ids,
                runner.model,
                runner.variant,
                0,
                pool,
                rounds_log,
                cand_log,
                seen,
                slim_traces,
                complete=False,
            ),
        )

    for k, x in enumerate(distill[start_round:], start=start_round):
        log.info(
            "[%s round %d/%d] %s | |Ω|=%d",
            setting,
            k + 1,
            len(distill),
            x["instance_id"],
            len(pool),
        )

        t = runner.run_task(x, pool)
        log.info("  task session complete; skills=%s", skill_use_label(t))
        evaluator.evaluate([t], instances, tag=f"{setting}-r{k}")

        e = build_round_evidence(
            cfg, use_feedback, runner, evaluator, instances, x, t, pool
        )

        est = estimator.estimate(e)
        entry = {
            "round": k,
            "instance_id": x["instance_id"],
            "resolved": t.resolved,
            "error": t.error,
            "cost": {
                "total_tokens": t.c_task_tokens,
                "in_tok_cached": t.c_in_tok_cached,
                "out_tok": t.c_out_tok,
                "cost_usd": usd_cost(t, budgets.pricing),
                "time_sec": t.c_time,
                "tool_calls": t.c_call,
            },
            "evidence_kind": e.kind,
            "estimator": {"passed": est.passed, **est.components},
        }

        if est.passed:
            pool_before = pool.to_dict()
            candidates = distiller.distill(e, pool)
            entry["candidates"] = [op.op for op in candidates]
            if not candidates:
                log.info("  no candidates proposed")
            else:
                scored = distiller.score_candidates(candidates, e, pool)
                entry["scoring"] = [
                    {
                        "op": op.op,
                        "name": getattr(op, "name", ""),
                        "score": round(s, 4),
                        "dims": getattr(op, "score_dims", None),
                    }
                    for op, s in scored
                ]
                best = max((s for _, s in scored), default=0.0)
                accepted_ops = [op for op, s in scored if s >= score_threshold][
                    : distiller.K
                ]

                cand_log.append(
                    {
                        "round": k,
                        "instance_id": x["instance_id"],
                        "evidence_kind": e.kind,
                        "pool_before": pool_before,
                        "threshold": score_threshold,
                        "max_apply": distiller.K,
                        "candidates": [
                            {
                                **asdict(op),
                                "score": round(s, 4),
                                "score_dims": getattr(op, "score_dims", None),
                                "accepted": op in accepted_ops,
                            }
                            for op, s in scored
                        ],
                    }
                )
                if accepted_ops:
                    applied = pool.apply(Patch(ops=accepted_ops), round_idx=k)
                    entry["applied"] = applied
                    log.info(
                        "  accepted %d/%d candidates (threshold=%.2f, best=%.4f): %s",
                        len(accepted_ops),
                        len(candidates),
                        score_threshold,
                        best,
                        applied,
                    )
                else:
                    log.info(
                        "  rejected all %d candidate(s): none above threshold %.2f (best=%.4f)",
                        len(candidates),
                        score_threshold,
                        best,
                    )
        else:
            scores = ", ".join(
                f"{name}={est.components[name]:.2f}"
                for name in ("reusable", "safe", "informative")
                if isinstance(est.components.get(name), (int, float))
            )
            log.info(
                "  estimator gate not passed (%s)",
                scores or est.components.get("reason", "no reason"),
            )

        seen.append(t)
        log.info(
            "  resolved=%s skills=%s tok=%d in_tok_cached=%d out_tok=%d time=%.1f calls=%d",
            t.resolved,
            skill_use_label(t),
            t.c_task_tokens,
            t.c_in_tok_cached,
            t.c_out_tok,
            t.c_time,
            t.c_call,
        )
        rounds_log.append(entry)

        for tr in e.all_traces():
            role = tr.feedback.get("fork_role") or "primary"
            slim_traces.append(tr.slim(round=k, role=role))
            if ws := tr.feedback.get("workspace"):
                runner.cleanup_ws(Path(ws))

        write_json(
            checkpoint_path,
            _distill_checkpoint(
                setting,
                instance_ids,
                runner.model,
                runner.variant,
                k + 1,
                pool,
                rounds_log,
                cand_log,
                seen,
                slim_traces,
                complete=False,
            ),
        )

    pool.save(out / f"skillpool_{setting}.json")
    write_json(out / f"rounds_{setting}.json", rounds_log)
    write_json(out / f"candidates_{setting}.json", cand_log)
    write_json(out / f"traces_{setting}.json", slim_traces)
    report = build_train_report(
        setting, distill, seen, budgets, instances, n_skills=len(pool)
    )
    write_json(out / f"train_report_{setting}.json", report)
    md_dir = pool.export_md(out / f"skills_md_{setting}")
    print_train_table(report, setting, cfg)
    write_json(
        checkpoint_path,
        _distill_checkpoint(
            setting,
            instance_ids,
            runner.model,
            runner.variant,
            len(distill),
            pool,
            rounds_log,
            cand_log,
            seen,
            slim_traces,
            complete=True,
        ),
    )
    log.info(
        "[%s] distillation done, |Ω|=%d, artifacts in %s (md skills -> %s)",
        setting,
        len(pool),
        out,
        md_dir,
    )
    return pool


def print_train_table(report: dict, setting: str, cfg: Config) -> None:
    reports = load_train_reports(cfg)
    reports[setting] = report
    reports = {name: reports[name] for name in SETTINGS if name in reports}
    try:
        console = _metric_console()
    except Exception:
        log.info(
            "[%s] cumulative train metrics: %s",
            setting,
            {
                name: {column: metrics.get(column) for column in _TABLE_COLS}
                for name, metrics in reports.items()
            },
        )
        return
    rows = [
        (f"{name} (|Ω|={metrics.get('n_skills', 0)})", metrics)
        for name, metrics in reports.items()
    ]
    title = (
        f"Training set — cumulative after {setting} "
        f"(D_train={report['train_size']})"
    )
    console.print(
        _metric_table(title, rows, repeats=1, base_row=reports.get("base"))
    )
    for table in _difficulty_tables(
        reports, repeats=1, prefix="Training difficulty"
    ):
        console.print(table)


def try_fork(runner, evaluator, instances, x, neg_trace, pool, hint):
    hint = hint or _DEFAULT_FAILURE_FEEDBACK
    if not neg_trace.messages or neg_trace.messages[-1].text != hint:
        neg_trace.add_message("user", hint)
    pos = runner.fork_run(x, neg_trace, pool, hint)
    log.info("  fork session skills=%s", skill_use_label(pos))
    evaluator.evaluate([pos], instances, tag=f"fork-{uuid.uuid4().hex[:8]}")
    feedback.attach_feedback(pos, True)

    if pos.resolved and not neg_trace.resolved:
        pos.add_message("user", _DEFAULT_SUCCESS_FEEDBACK)
        neg_trace.feedback["fork_role"] = "negative"
        pos.feedback["fork_role"] = "positive"
        return build_pair(x, neg_trace, pos)

    pos_ws, neg_ws = pos.feedback.get("workspace"), neg_trace.feedback.get("workspace")
    if pos_ws and pos_ws != neg_ws:
        runner.cleanup_ws(Path(pos_ws))
    return None


def build_round_evidence(
    cfg: Config,
    use_feedback: bool,
    runner: OpenCodeRunner,
    evaluator: Evaluator,
    instances: dict[str, dict],
    x: dict,
    trace,
    pool: SkillPool,
) -> Evidence:
    feedback.attach_feedback(trace, use_feedback)
    if not use_feedback:
        return build_single(x, trace)

    if not trace.resolved:
        hint = _DEFAULT_FAILURE_FEEDBACK
        trace.add_message("user", hint)
        if cfg.get("feedback.enable_fork", True):
            return (
                try_fork(runner, evaluator, instances, x, trace, pool, hint)
                or build_single(x, trace)
            )
        return build_single(x, trace)

    trace.add_message("user", _DEFAULT_SUCCESS_FEEDBACK)
    return build_single(x, trace)
