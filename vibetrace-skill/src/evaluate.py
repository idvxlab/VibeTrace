from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
import logging
import os
import statistics
import subprocess
import uuid
from pathlib import Path

from . import dataset
from .budget import BudgetTable
from .config import Config
from .constants import DISTILL_SETTINGS, SETTINGS, normalize_settings
from .evaluator import Evaluator
from .objective import usd_cost, verifier_objective
from .opencode_runner import OpenCodeRunner
from .parallel import run_tasks
from .skillpool import SkillPool
from .trace import Trace, skill_use_label

log = logging.getLogger("vibetrace.eval")

_TABLE_COLS = [
    "pass_rate",
    "avg_total_tokens",
    "avg_in_tok_cached",
    "avg_out_tok",
    "avg_cost_usd",
    "avg_time_sec",
    "avg_tool_calls",
    "avg_objective",
    "skill_use_rate",
    "error_rate",
]

def _table_width() -> int:
    try:
        return max(120, int(os.environ.get("VIBETRACE_TABLE_WIDTH", "420")))
    except ValueError:
        return 420


_TABLE_WIDTH = _table_width()


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def write_report(out: Path, report: dict) -> None:
    write_json(out / "report.json", report)


def _trace_map(raw: dict | None) -> dict[str, Trace]:
    return {
        instance_id: Trace.from_dict(payload)
        for instance_id, payload in (raw or {}).items()
        if isinstance(instance_id, str) and isinstance(payload, dict)
    }


def _slim_trace_map(traces: dict[str, Trace]) -> dict[str, dict]:
    return {instance_id: trace.slim() for instance_id, trace in traces.items()}


def _load_checkpoint(path: Path, identity: dict) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema_version") != 1 or data.get("identity") != identity:
        raise ValueError(
            f"incompatible checkpoint: {path}; dataset, settings, repeats, "
            "or skill-pool hashes changed"
        )
    return data


def sha256_file(path: Path) -> str | None:
    if not path.exists():
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def git_head() -> str | None:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10
        )
    except Exception:
        return None
    return proc.stdout.strip() if proc.returncode == 0 else None


def skillpool_path(cfg: Config, setting: str) -> Path:
    return cfg.resolve("run.output_dir") / "distill" / f"skillpool_{setting}.json"


def pool_metadata(cfg: Config, settings: tuple[str, ...]) -> dict:
    meta = {}
    for setting in settings:
        if setting == "base":
            meta[setting] = {"n_skills": 0, "sha256": None, "path": None}
            continue
        path = skillpool_path(cfg, setting)
        if not path.exists():
            meta[setting] = {"missing": True, "path": str(path)}
            continue
        pool = SkillPool.load(path)
        meta[setting] = {
            "n_skills": len(pool),
            "sha256": sha256_file(path),
            "path": str(path),
        }
    return meta


def check_repo_mirrors(runner: OpenCodeRunner, instances: list[dict]) -> None:
    missing = []
    for inst in instances:
        try:
            runner.ensure_repo_cache(inst["repo"])
        except FileNotFoundError as e:
            missing.append(str(e))
    if missing:
        raise FileNotFoundError(
            "missing repo mirror(s) before evaluation:\n"
            + "\n".join(f"- {m}" for m in missing)
        )


def load_pool(cfg: Config, setting: str) -> SkillPool:
    if setting == "base":
        return SkillPool()
    path = skillpool_path(cfg, setting)
    if not path.exists():
        raise FileNotFoundError(
            f"skill pool for {setting} not found: {path}; run distill first."
        )
    return SkillPool.load(path)


def compute_metrics(traces: list[Trace], budgets: BudgetTable) -> dict:
    n = len(traces)
    if n == 0:
        return {}
    resolved = sum(1 for t in traces if t.resolved)
    valid = [t for t in traces if not t.failed_run]
    errored = [t for t in traces if t.failed_run]
    nv = len(valid)

    def avg(f):
        return (sum(f(t) for t in valid) / nv) if nv else 0.0

    return {
        "n": n,
        "pass_rate": resolved / n,
        "resolved": resolved,
        "n_valid": nv,
        "n_errored": len(errored),
        "error_rate": len(errored) / n,
        "errored_ids": [t.instance_id for t in errored],
        "avg_total_tokens": avg(lambda t: float(t.c_task_tokens)),
        "avg_in_tok_cached": avg(lambda t: float(t.c_in_tok_cached)),
        "avg_cache_read_tokens": avg(
            lambda t: float(t.cost.cache_read_tokens)
        ),
        "avg_out_tok": avg(lambda t: float(t.c_out_tok)),
        "avg_cost_usd": avg(lambda t: usd_cost(t, budgets.pricing)),
        "avg_time_sec": avg(lambda t: t.c_time),
        "avg_tool_calls": avg(lambda t: t.c_call),
        "avg_objective": avg(lambda t: verifier_objective(t, budgets)),
        "empty_patch_rate": avg(lambda t: 0.0 if (t.diff or "").strip() else 1.0),
        "skill_use_rate": avg(
            lambda t: 1.0
            if any(a.tool.lower() == "skill" for a in t.actions)
            else 0.0
        ),
        "avg_skill_calls": avg(
            lambda t: sum(1 for a in t.actions if a.tool.lower() == "skill")
        ),
    }


def aggregate_runs(runs: list[dict]) -> dict:
    if not runs:
        return {}
    numeric_keys = [
        k
        for k, v in runs[0].items()
        if isinstance(v, (int, float)) and k != "n_runs" and not k.endswith("_std")
    ]
    agg: dict = {"n_runs": len(runs)}
    for k in numeric_keys:
        vals = [r[k] for r in runs if isinstance(r.get(k), (int, float))]
        agg[k] = sum(vals) / len(vals)
        agg[f"{k}_std"] = statistics.pstdev(vals) if len(vals) > 1 else 0.0
    return agg


def metrics_by_difficulty(
    traces: list[Trace], instances: dict[str, dict], budgets: BudgetTable
) -> dict[str, dict]:
    groups: dict[str, list[Trace]] = {}
    for t in traces:
        diff = (instances.get(t.instance_id) or {}).get("difficulty", "unknown")
        groups.setdefault(diff, []).append(t)
    return {d: compute_metrics(grp, budgets) for d, grp in sorted(groups.items())}


def aggregate_by_difficulty(runs: list[dict[str, dict]]) -> dict[str, dict]:
    all_diffs = sorted({d for r in runs for d in r})
    return {d: aggregate_runs([r[d] for r in runs if d in r]) for d in all_diffs}


def build_train_report(
    setting: str,
    distill: list[dict],
    traces: list[Trace],
    budgets: BudgetTable,
    instances: dict[str, dict],
    n_skills: int,
) -> dict:
    return {
        "setting": setting,
        "train_size": len(distill),
        "order": [x["instance_id"] for x in distill],
        "n_skills": n_skills,
        **compute_metrics(traces, budgets),
        "by_difficulty": metrics_by_difficulty(traces, instances, budgets),
    }


def run_train_base_eval(cfg: Config) -> dict:
    distill, _ = dataset.split(cfg)
    instances = {x["instance_id"]: x for x in distill}
    runner = OpenCodeRunner(cfg)
    evaluator = Evaluator(cfg)
    budgets = BudgetTable.from_config(cfg)
    concurrency = int(cfg.get("run.concurrency", 1))
    check_repo_mirrors(runner, distill)

    out = cfg.resolve("run.output_dir") / "distill"
    out.mkdir(parents=True, exist_ok=True)

    pool = SkillPool()
    instance_ids = [x["instance_id"] for x in distill]
    checkpoint_path = out / "checkpoint_base.json"
    identity = {
        "kind": "train-base",
        "instance_ids": instance_ids,
        "pool_sha256": None,
        "model": runner.model,
        "variant": runner.variant,
    }
    resume = bool(cfg.get("run.resume", False))
    if resume and checkpoint_path.exists():
        checkpoint = _load_checkpoint(checkpoint_path, identity)
        trace_by_id = _trace_map(checkpoint.get("traces"))
        log.info(
            "[train-base] resume from %s: %d/%d task sessions complete",
            checkpoint_path,
            len(trace_by_id),
            len(distill),
        )
    else:
        checkpoint = {
            "schema_version": 1,
            "identity": identity,
            "complete": False,
            "traces": {},
        }
        trace_by_id = {}
        write_json(checkpoint_path, checkpoint)

    index_by_id = {instance_id: i for i, instance_id in enumerate(instance_ids)}
    pending = [x for x in distill if x["instance_id"] not in trace_by_id]
    jobs = [(x, pool) for x in pending]

    def log_done(i, t):
        trace_by_id[t.instance_id] = t
        checkpoint["traces"] = _slim_trace_map(trace_by_id)
        checkpoint["complete"] = False
        write_json(checkpoint_path, checkpoint)
        overall = index_by_id[t.instance_id]
        log.info(
            "[train-base %d/%d] %s skills=%s%s",
            overall + 1,
            len(distill),
            t.instance_id,
            skill_use_label(t),
            f" (ERROR: {t.error})" if t.error else "",
        )

    log.info("===== train-set baseline (base, |Ω|=0) over %d tasks =====", len(distill))
    if jobs:
        run_tasks(runner, jobs, concurrency, cleanup=True, on_done=log_done)
    traces = [trace_by_id[instance_id] for instance_id in instance_ids]
    if not checkpoint.get("complete"):
        evaluator.evaluate(traces, instances, tag="train-base")
        checkpoint["traces"] = {
            t.instance_id: t.slim(round=k, role="primary")
            for k, t in enumerate(traces)
        }
        checkpoint["complete"] = True
        write_json(checkpoint_path, checkpoint)

    write_json(
        out / "traces_base.json",
        [t.slim(round=k, role="primary") for k, t in enumerate(traces)],
    )
    report = build_train_report("base", distill, traces, budgets, instances, n_skills=0)
    write_json(out / "train_report_base.json", report)
    from .distill_loop import print_train_table

    print_train_table(report, "base", cfg)
    return report


def run_single_seed_pipeline(cfg: Config) -> dict:
    from .distill_loop import run_distillation

    distill, test = dataset.split(cfg)
    log.info(
        "[seed=%s] D_distill=%d D_test=%d",
        cfg.get("dataset.shuffle_seed", "?"),
        len(distill),
        len(test),
    )
    settings = normalize_settings(cfg.get("run.settings"))
    offset = int(cfg.get("run.setting_order_offset", 0)) % len(settings)
    ordered = settings[offset:] + settings[:offset]
    repeats = int(cfg.get("run.repeats", 1))
    stage_reports = []

    log.info(
        "[seed=%s] staged mode order=%s",
        cfg.get("dataset.shuffle_seed", "?"),
        " -> ".join(ordered),
    )
    for setting in ordered:
        if setting == "base":
            run_train_base_eval(cfg)
        else:
            run_distillation(cfg, setting)
        log.info(
            "[%s] training complete; freezing pool and starting held-out test",
            setting,
        )
        stage_reports.append(
            run_final_eval(cfg, settings=(setting,), repeats=repeats)
        )
        report = merge_final_reports(cfg, stage_reports)

    return report_both_schemes(cfg, report)


def configured_seeds(cfg: Config) -> list[int]:
    raw = cfg.get("run.seeds")
    if raw is None:
        return [int(cfg.get("dataset.shuffle_seed", 42))]
    if isinstance(raw, (int, str)):
        return [int(raw)]
    return [int(s) for s in raw]


def aggregate_combined_reports(
    reports: list[dict], seeds: list[int], cfg: Config
) -> dict:
    def section(name: str) -> dict[str, dict]:
        out = {}
        settings = [
            s for s in SETTINGS if any(s in (r.get(name) or {}) for r in reports)
        ]
        for setting in settings:
            rows = [(r.get(name) or {}).get(setting) for r in reports]
            rows = [r for r in rows if r]
            agg = aggregate_runs(rows)
            agg["by_difficulty"] = aggregate_by_difficulty(
                [r.get("by_difficulty", {}) for r in rows]
            )
            out[setting] = agg
        return out

    return {
        "train_prequential": section("train_prequential"),
        "test_frozen_pool": section("test_frozen_pool"),
        "train_size": reports[0].get("train_size") if reports else None,
        "test_size": reports[0].get("test_size") if reports else None,
        "seeds": seeds,
        "n_seeds": len(seeds),
        "eval_repeats_per_seed": int(cfg.get("run.repeats", 1)),
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }


def run_multi_seed_pipeline(cfg: Config) -> dict:
    seeds = configured_seeds(cfg)
    base_out = cfg.get("run.output_dir", "results")
    reports: list[dict] = []
    for i, seed in enumerate(seeds, 1):
        sub_cfg = cfg.clone()
        sub_cfg.set("dataset.shuffle_seed", seed)
        sub_cfg.set("run.output_dir", f"{base_out}/seed_{seed}")
        selected = normalize_settings(sub_cfg.get("run.settings"))
        offset = (
            (i - 1) % len(selected)
            if bool(sub_cfg.get("run.counterbalance_settings", True))
            else 0
        )
        sub_cfg.set("run.setting_order_offset", offset)
        log.info(
            "===== seed %d/%d: %s -> %s =====",
            i,
            len(seeds),
            seed,
            sub_cfg.get("run.output_dir"),
        )
        reports.append(run_single_seed_pipeline(sub_cfg))

    if len(reports) == 1:
        return reports[0]

    combined = aggregate_combined_reports(reports, seeds, cfg)
    out = cfg.resolve("run.output_dir")
    out.mkdir(parents=True, exist_ok=True)
    write_json(out / "multiseed_report.json", combined)
    print_combined_tables(combined)
    log.info("multi-seed report -> %s", out / "multiseed_report.json")
    return combined


def run_final_eval(cfg: Config, settings=SETTINGS, repeats: int = 1) -> dict:
    repeats = max(1, int(repeats))
    settings = tuple(settings)
    _, test = dataset.split(cfg)
    instances = {x["instance_id"]: x for x in test}
    instance_ids = [x["instance_id"] for x in test]
    runner = OpenCodeRunner(cfg)
    evaluator = Evaluator(cfg)
    budgets = BudgetTable.from_config(cfg)
    concurrency = int(cfg.get("run.concurrency", 1))
    check_repo_mirrors(runner, test)

    out = cfg.resolve("run.output_dir") / "final"
    out.mkdir(parents=True, exist_ok=True)
    pool_meta = pool_metadata(cfg, settings)
    identity = {
        "kind": "final-eval",
        "dataset": cfg.get("dataset.name"),
        "test_instance_ids": instance_ids,
        "settings": list(settings),
        "repeats": repeats,
        "skill_pools": pool_meta,
        "model": runner.model,
        "variant": runner.variant,
    }
    checkpoint_scope = "_".join(settings)
    checkpoint_name = (
        "checkpoint.json"
        if settings == SETTINGS
        else f"checkpoint_{checkpoint_scope}.json"
    )
    checkpoint_path = out / checkpoint_name
    resume = bool(cfg.get("run.resume", False))
    if resume and checkpoint_path.exists():
        checkpoint = _load_checkpoint(checkpoint_path, identity)
        log.info("[final] resume from %s", checkpoint_path)
    else:
        checkpoint = {
            "schema_version": 1,
            "identity": identity,
            "complete": False,
            "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "units": {},
        }
        write_json(checkpoint_path, checkpoint)

    report = {
        "dataset": cfg.get("dataset.name"),
        "test_size": len(test),
        "repeats": repeats,
        "settings": {},
        "complete": False,
        "started_at": checkpoint.get("started_at"),
        "finished_at": None,
        "artifact_dir": str(out),
        "git_head": git_head(),
        "config": copy.deepcopy(cfg.data),
        "split": {
            "test_instance_ids": instance_ids,
            "test_difficulties": {
                x["instance_id"]: x.get("difficulty", "unknown") for x in test
            },
        },
        "skill_pools": pool_meta,
    }
    write_report(out, report)

    pools = {setting: load_pool(cfg, setting) for setting in settings}
    per_run: dict[str, list[dict]] = {s: [] for s in settings}
    per_run_by_diff: dict[str, list[dict[str, dict]]] = {s: [] for s in settings}
    index_by_id = {instance_id: i for i, instance_id in enumerate(instance_ids)}

    for r in range(repeats):
        rotated = settings[r % len(settings) :] + settings[: r % len(settings)]
        for setting in rotated:
            pool = pools[setting]
            log.info(
                "===== final eval setting=%s (|Ω|=%d), run %d/%d =====",
                setting,
                len(pool),
                r + 1,
                repeats,
            )
            unit_key = f"{setting}:r{r + 1}"
            unit = checkpoint["units"].setdefault(
                unit_key, {"complete": False, "traces": {}}
            )
            trace_by_id = _trace_map(unit.get("traces"))
            if unit.get("complete"):
                missing = [i for i in instance_ids if i not in trace_by_id]
                if missing:
                    raise ValueError(
                        f"completed checkpoint unit {unit_key} is missing {missing}"
                    )
                log.info(
                    "[%s run%d/%d] checkpoint complete; skipping %d task sessions",
                    setting,
                    r + 1,
                    repeats,
                    len(test),
                )

            pending = [x for x in test if x["instance_id"] not in trace_by_id]
            jobs = [(x, pool) for x in pending]

            def log_done(i, t, _s=setting, _r=r):
                trace_by_id[t.instance_id] = t
                unit["traces"] = _slim_trace_map(trace_by_id)
                unit["complete"] = False
                checkpoint["complete"] = False
                write_json(checkpoint_path, checkpoint)
                overall = index_by_id[t.instance_id]
                log.info(
                    "[%s run%d/%d %d/%d] %s skills=%s%s",
                    _s,
                    _r + 1,
                    repeats,
                    overall + 1,
                    len(test),
                    t.instance_id,
                    skill_use_label(t),
                    f" (ERROR: {t.error})" if t.error else "",
                )

            if jobs:
                run_tasks(runner, jobs, concurrency, cleanup=True, on_done=log_done)
            traces = [trace_by_id[instance_id] for instance_id in instance_ids]
            if not unit.get("complete"):
                evaluator.evaluate(
                    traces, instances, tag=f"test-{setting}-r{r + 1}"
                )
                unit["traces"] = {t.instance_id: t.slim() for t in traces}
                unit["complete"] = True
                write_json(checkpoint_path, checkpoint)

            per_run[setting].append(compute_metrics(traces, budgets))
            per_run_by_diff[setting].append(
                metrics_by_difficulty(traces, instances, budgets)
            )

            agg = aggregate_runs(per_run[setting])
            agg["runs"] = per_run[setting]
            agg["by_difficulty"] = aggregate_by_difficulty(per_run_by_diff[setting])
            agg["complete"] = r + 1 == repeats
            report["settings"][setting] = agg

            suffix = f"_{setting}" if repeats == 1 else f"_{setting}_r{r + 1}"
            write_json(out / f"traces{suffix}.json", [t.slim() for t in traces])
            write_report(out, report)
            print_table(report, label=f"{setting} {r + 1}/{repeats}")

    report["complete"] = True
    report["finished_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    checkpoint["complete"] = True
    checkpoint["finished_at"] = report["finished_at"]
    write_json(checkpoint_path, checkpoint)
    write_report(out, report)
    print_table(report)
    return report


def merge_final_reports(cfg: Config, reports: list[dict]) -> dict:
    if not reports:
        raise ValueError("staged evaluation produced no reports")
    merged = copy.deepcopy(reports[0])
    merged["settings"] = {}
    merged["skill_pools"] = {}
    merged["complete"] = all(bool(report.get("complete")) for report in reports)
    starts = [report.get("started_at") for report in reports if report.get("started_at")]
    finishes = [
        report.get("finished_at") for report in reports if report.get("finished_at")
    ]
    merged["started_at"] = min(starts) if starts else None
    merged["finished_at"] = max(finishes) if finishes else None
    for report in reports:
        if report.get("test_size") != merged.get("test_size"):
            raise ValueError("cannot merge staged reports with different test sets")
        merged["settings"].update(report.get("settings") or {})
        merged["skill_pools"].update(report.get("skill_pools") or {})

    out = cfg.resolve("run.output_dir") / "final"
    write_report(out, merged)
    print_table(merged, label="all completed stages")
    return merged


def _fmt_metric(d: dict, key: str, repeats: int, none_str: str = "") -> str:
    v = d.get(key)
    if not isinstance(v, float):
        return none_str if v is None else str(v)
    std = d.get(f"{key}_std")
    if repeats > 1 and isinstance(std, (int, float)):
        return f"{v:.3f} ± {std:.3f}"
    return f"{v:.3f}"


def _fmt_in_tok_cached(d: dict, repeats: int, none_str: str = "") -> str:
    in_tok = _fmt_metric(d, "avg_in_tok_cached", repeats, none_str=none_str)
    cached = _fmt_metric(
        d, "avg_cache_read_tokens", repeats, none_str=none_str
    )
    return f"{in_tok} ({cached})"


def _delta_pct(base_v, x) -> float | None:
    if (
        not isinstance(base_v, (int, float))
        or not isinstance(x, (int, float))
        or not base_v
    ):
        return None
    return (x - base_v) / base_v * 100.0


def _metric_table(
    title: str, rows: list[tuple[str, dict]], repeats: int, base_row: dict | None = None
):
    from rich.table import Table

    table = Table(title=title)
    table.add_column("setting", no_wrap=True)
    for c in _TABLE_COLS:
        table.add_column(c, no_wrap=True)
    for label, m in rows:
        cells = []
        for c in _TABLE_COLS:
            cell = (
                _fmt_in_tok_cached(m, repeats, none_str="—")
                if c == "avg_in_tok_cached"
                else _fmt_metric(m, c, repeats, none_str="—")
            )
            if base_row is not None and m is not base_row:
                d = _delta_pct(base_row.get(c), m.get(c))
                if d is not None:
                    cell = f"{cell} ({d:+.1f}%)"
            cells.append(cell)
        table.add_row(label, *cells)
    return table


def _metric_console():
    from rich.console import Console

    return Console(width=_TABLE_WIDTH)


def _difficulty_tables(
    settings: dict[str, dict], repeats: int, prefix: str = "Difficulty"
):
    all_diffs = sorted(
        {d for m in settings.values() for d in (m.get("by_difficulty") or {})}
    )
    for d in all_diffs:
        rows = []
        for setting, m in settings.items():
            dm = (m.get("by_difficulty") or {}).get(d, {})
            n = dm.get("n")
            rows.append((f"{setting} (n={n})" if n is not None else setting, dm))
        base = ((settings.get("base") or {}).get("by_difficulty") or {}).get(d)
        yield _metric_table(f"{prefix}: {d}", rows, repeats, base_row=base)


def print_table(report: dict, *, label: str = "") -> None:
    try:
        console = _metric_console()
    except Exception:
        print(json.dumps(report["settings"], indent=2, ensure_ascii=False))
        return

    repeats = report.get("repeats", 1)
    settings = report["settings"]
    title = f"Final eval — {report['dataset']} (D_test={report['test_size']}, repeats={repeats})"
    if label:
        title += f"  [{label}]"
    console.print(
        _metric_table(
            title, list(settings.items()), repeats, base_row=settings.get("base")
        )
    )
    for table in _difficulty_tables(settings, repeats):
        console.print(table)


def load_train_reports(cfg: Config) -> dict[str, dict]:
    out = cfg.resolve("run.output_dir") / "distill"
    reports: dict[str, dict] = {}
    for setting in SETTINGS:
        path = out / f"train_report_{setting}.json"
        if path.exists():
            reports[setting] = json.loads(path.read_text(encoding="utf-8"))
    return reports


def report_both_schemes(
    cfg: Config,
    final_report: dict | None = None,
    train_reports: dict[str, dict] | None = None,
) -> dict:
    if final_report is None:
        path = cfg.resolve("run.output_dir") / "final" / "report.json"
        final_report = (
            json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        )
    if train_reports is None:
        train_reports = load_train_reports(cfg)
    combined = {
        "train_prequential": train_reports,
        "test_frozen_pool": final_report.get("settings", {}),
        "train_size": next((r.get("train_size") for r in train_reports.values()), None),
        "test_size": final_report.get("test_size"),
        "repeats": final_report.get("repeats", 1),
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    art_dir = Path(final_report.get("artifact_dir") or cfg.resolve("run.output_dir"))
    art_dir.mkdir(parents=True, exist_ok=True)
    write_json(art_dir / "combined_report.json", combined)
    print_combined_tables(combined)
    log.info("combined two-scheme report -> %s", art_dir / "combined_report.json")
    return combined


def _section_repeats(section: dict[str, dict]) -> int:
    return max((m.get("n_runs", 1) for m in section.values()), default=1)


def print_combined_tables(combined: dict) -> None:
    try:
        console = _metric_console()
    except Exception:
        print(
            json.dumps(
                {k: combined[k] for k in ("train_prequential", "test_frozen_pool")},
                indent=2,
                ensure_ascii=False,
            )
        )
        return

    train = combined.get("train_prequential") or {}
    if train:
        repeats = _section_repeats(train)
        repeat_label = "seeds" if combined.get("seeds") else "repeats"
        rows = [(f"{s} (|Ω|={m.get('n_skills', 0)})", m) for s, m in train.items()]
        console.print(
            _metric_table(
                f"Scheme 2 — training set, prequential stream "
                f"(D_train={combined.get('train_size')}, {repeat_label}={repeats})",
                rows,
                repeats,
                base_row=train.get("base"),
            )
        )
        for table in _difficulty_tables(train, repeats, prefix="Scheme 2 difficulty"):
            console.print(table)

    test = combined.get("test_frozen_pool") or {}
    if test:
        repeats = _section_repeats(test)
        repeat_label = "seeds" if combined.get("seeds") else "repeats"
        console.print(
            _metric_table(
                f"Scheme 1 — held-out test set, frozen pool "
                f"(D_test={combined.get('test_size')}, {repeat_label}={repeats})",
                list(test.items()),
                repeats,
                base_row=test.get("base"),
            )
        )
