from __future__ import annotations

import argparse
import datetime as dt
import logging
import sys
from dataclasses import dataclass
from typing import Callable

from . import dataset
from .config import Config
from .constants import DISTILL_SETTINGS, SETTINGS, normalize_settings


@dataclass(frozen=True)
class CliOverrides:
    concurrency: int | None = None
    repeats: int | None = None
    resume: bool | None = None
    settings: tuple[str, ...] | None = None


Command = Callable[[Config, argparse.Namespace], None]


def run_slug(name: str) -> str:
    return name.replace("-", "_")


def setup_logging(cfg: Config) -> None:
    logging.basicConfig(
        level=getattr(logging, cfg.get("run.log_level", "INFO")),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )


def cmd_split(cfg: Config, _args: argparse.Namespace) -> None:
    distill, test = dataset.split(cfg)
    print(f"D_distill = {len(distill)} instances, D_test = {len(test)} instances")
    for name, part in (("D_distill", distill), ("D_test", test)):
        diff: dict[str, int] = {}
        for x in part:
            key = x.get("difficulty", "?")
            diff[key] = diff.get(key, 0) + 1
        repos = sorted({x["repo"] for x in part})
        print(f"{name} difficulty:", dict(sorted(diff.items())), "| repos:", repos)


def cmd_distill(cfg: Config, args: argparse.Namespace) -> None:
    from .distill_loop import run_distillation

    settings = normalize_settings(cfg.get("run.settings"))
    for setting in (s for s in settings if s in DISTILL_SETTINGS):
        pool = run_distillation(cfg, setting)
        print(f"[{setting}] distilled {len(pool)} skills")


def cmd_evaluate(cfg: Config, args: argparse.Namespace) -> None:
    from .evaluate import run_final_eval

    run_final_eval(
        cfg,
        settings=normalize_settings(cfg.get("run.settings")),
        repeats=int(cfg.get("run.repeats", 1)),
    )


def cmd_run_all(cfg: Config, args: argparse.Namespace) -> None:
    from .evaluate import run_multi_seed_pipeline

    run_multi_seed_pipeline(cfg)


def cmd_train_base(cfg: Config, _args: argparse.Namespace) -> None:
    from .evaluate import run_train_base_eval

    run_train_base_eval(cfg)


def cmd_report(cfg: Config, _args: argparse.Namespace) -> None:
    from .evaluate import report_both_schemes

    report_both_schemes(cfg)


def cmd_inspect(cfg: Config, args: argparse.Namespace) -> None:
    from .evaluate import skillpool_path
    from .skillpool import SkillPool

    path = skillpool_path(cfg, args.setting)
    if not path.exists():
        print(f"not found: {path}")
        return
    pool = SkillPool.load(path)
    print(f"setting={args.setting}, {len(pool)} skills:\n")
    for sk in pool.list():
        print(f"### {sk.name}  (id={sk.id}, kind={sk.kind})")
        print(sk.content)
        print()


def add_concurrency_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--concurrency",
        type=int,
        default=None,
        help="parallel task runs; overrides run.concurrency",
    )


def add_run_control_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--output-dir",
        default=None,
        help="artifact root; point this at an earlier run when using --resume",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        default=None,
        help="resume completed tasks from checkpoints under the output directory",
    )
    parser.add_argument(
        "--settings",
        nargs="+",
        choices=list(SETTINGS),
        default=None,
        help="run only the selected experiment settings, in the given order",
    )


def add_eval_args(parser: argparse.ArgumentParser) -> None:
    add_run_control_args(parser)
    add_concurrency_arg(parser)
    parser.add_argument(
        "--repeats",
        type=int,
        default=None,
        help="final-eval repeats; in run-all this is per seed",
    )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="vibetrace", description="Skill self-evolution / SWE-bench Verified"
    )
    p.add_argument("--config", default=None, help="path to a YAML config override")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("split", help="print dataset split overview").set_defaults(
        func=cmd_split
    )

    distill = sub.add_parser("distill", help="serial prequential distillation")
    add_run_control_args(distill)
    distill.set_defaults(func=cmd_distill)

    evaluate = sub.add_parser("evaluate", help="held-out final evaluation")
    add_eval_args(evaluate)
    evaluate.set_defaults(func=cmd_evaluate)

    run_all = sub.add_parser(
        "run-all", help="multi-seed train-base -> distill -> held-out eval"
    )
    add_eval_args(run_all)
    run_all.set_defaults(func=cmd_run_all)

    train_base = sub.add_parser("train-base", help="no-skill baseline on D_distill")
    add_run_control_args(train_base)
    add_concurrency_arg(train_base)
    train_base.set_defaults(func=cmd_train_base)

    sub.add_parser(
        "report", help="print combined report from existing artifacts"
    ).set_defaults(func=cmd_report)

    inspect = sub.add_parser("inspect", help="view a distilled skill pool")
    inspect.add_argument(
        "--setting", default="trace-fb", choices=list(DISTILL_SETTINGS)
    )
    inspect.set_defaults(func=cmd_inspect)
    return p


def model_slug(model: str) -> str:
    return model.replace("/", "__").replace(":", "_")


def cli_overrides(args: argparse.Namespace) -> CliOverrides:
    return CliOverrides(
        concurrency=getattr(args, "concurrency", None),
        repeats=getattr(args, "repeats", None),
        resume=getattr(args, "resume", None),
        settings=(
            tuple(args.settings) if getattr(args, "settings", None) else None
        ),
    )


def apply_overrides(cfg: Config, overrides: CliOverrides) -> None:
    if overrides.concurrency is not None:
        cfg.set("run.concurrency", int(overrides.concurrency))
    if overrides.repeats is not None:
        cfg.set("run.repeats", int(overrides.repeats))
    if overrides.resume is not None:
        cfg.set("run.resume", bool(overrides.resume))
    if overrides.settings is not None:
        cfg.set("run.settings", list(overrides.settings))


def assign_run_output_dir(cfg: Config, args: argparse.Namespace) -> None:
    if explicit := getattr(args, "output_dir", None):
        cfg.set("run.output_dir", explicit)
        return
    if getattr(args, "cmd", "") != "run-all" or getattr(args, "resume", False):
        return
    root = str(cfg.get("run.results_root", "results")).rstrip("/")
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d_%H%M%S")
    cfg.set("run.output_dir", f"{root}/results_{run_slug(args.cmd)}_{stamp}")


def run_for_configured_models(
    cfg: Config, args: argparse.Namespace, command: Command
) -> None:
    models = cfg.models()
    overrides = cli_overrides(args)
    assign_run_output_dir(cfg, args)
    if not models:
        apply_overrides(cfg, overrides)
        command(cfg, args)
        return

    log = logging.getLogger("vibetrace")
    base_out = cfg.get("run.output_dir", "results")
    for i, model in enumerate(models, 1):
        sub_cfg = cfg.clone()
        sub_cfg.set("opencode.model", model)
        sub_cfg.set("run.output_dir", f"{base_out}/by_model/{model_slug(model)}")
        apply_overrides(sub_cfg, overrides)
        log.info(
            "=== model %d/%d: %s -> %s ===",
            i,
            len(models),
            model,
            sub_cfg.get("run.output_dir"),
        )
        command(sub_cfg, args)


def main(argv=None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    args = build_parser().parse_args(argv)
    cfg = Config.load(args.config)
    setup_logging(cfg)
    run_for_configured_models(cfg, args, args.func)


if __name__ == "__main__":
    main()
