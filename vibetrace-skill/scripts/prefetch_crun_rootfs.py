from __future__ import annotations

import argparse
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from src import dataset
from src.config import Config
from src.crun_backend import CrunBackend

DEFAULT_SEEDS = (42, 43, 44)


def collect_instance_ids(
    cfg: Config, seeds: list[int]
) -> tuple[list[str], dict[int, int]]:
    instance_ids: dict[str, None] = {}
    counts: dict[int, int] = {}
    for seed in seeds:
        seed_cfg = cfg.clone()
        seed_cfg.set("dataset.shuffle_seed", seed)
        train, test = dataset.split(seed_cfg)
        ids = [item["instance_id"] for item in [*train, *test]]
        counts[seed] = len(ids)
        instance_ids.update(dict.fromkeys(ids))
    return list(instance_ids), counts


def cache_state(cache_root: Path, instance_id: str) -> str:
    dest = cache_root / instance_id
    if (dest / ".pull_tmp").is_dir():
        return "pulling"
    if (dest / "rootfs" / "testbed").is_dir():
        return "ready"
    if dest.exists():
        return "incomplete"
    return "missing"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Pre-download crun rootfs images for the union of SWE-bench tasks "
            "selected by one or more seeds."
        )
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Optional YAML config override; defaults to config/default.yaml.",
    )
    parser.add_argument(
        "--seeds",
        nargs="+",
        type=int,
        default=list(DEFAULT_SEEDS),
        help="Dataset seeds to include. Default: 42 43 44.",
    )
    parser.add_argument(
        "--attempts",
        type=int,
        default=2,
        help="Whole-image attempts for each missing or incomplete image. Default: 2.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=2,
        help="Images to fetch concurrently. Shared layers are downloaded once. Default: 2.",
    )
    parser.add_argument(
        "--list-only",
        action="store_true",
        help="Show the union and current cache state without downloading.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.attempts < 1:
        raise SystemExit("--attempts must be at least 1")
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")

    cfg = Config.load(args.config)
    instance_ids, per_seed = collect_instance_ids(cfg, args.seeds)
    cache_root = cfg.resolve(
        "evaluator.crun.rootfs_cache", "data/swe-bench-verified/crun-rootfs"
    )

    print(
        f"Seeds: {args.seeds} | per-seed tasks: {per_seed} | "
        f"unique images: {len(instance_ids)}"
    )
    print(f"Cache: {cache_root}")
    print(f"Proxy: {cfg.get('evaluator.crun.proxy') or '(environment/default)'}")
    print(f"Workers: {args.workers}")

    states = {
        instance_id: cache_state(cache_root, instance_id)
        for instance_id in instance_ids
    }
    for state in ("ready", "pulling", "incomplete", "missing"):
        print(f"{state}: {sum(value == state for value in states.values())}")

    if args.list_only:
        for instance_id, state in states.items():
            print(f"[{state.upper():10}] {instance_id}")
        return 0

    backend = CrunBackend(cfg)
    failures: list[tuple[str, str]] = []
    total = len(instance_ids)
    print_lock = threading.Lock()

    def pull_one(index: int, instance_id: str, initial_state: str):
        action = (
            "REPAIR" if initial_state in ("pulling", "incomplete") else "PULL"
        )
        last_error = ""
        for attempt in range(1, args.attempts + 1):
            with print_lock:
                print(
                    f"[{index}/{total}] {action} {instance_id} "
                    f"(attempt {attempt}/{args.attempts})",
                    flush=True,
                )
            try:
                path = backend.ensure_rootfs(instance_id)
                with print_lock:
                    print(f"             READY  {path}", flush=True)
                return None
            except Exception as exc:
                last_error = str(exc)
                with print_lock:
                    print(
                        f"             FAILED {last_error}",
                        file=sys.stderr,
                        flush=True,
                    )
        return instance_id, last_error

    pending = []
    for index, instance_id in enumerate(instance_ids, 1):
        initial_state = states[instance_id]
        if initial_state == "ready":
            print(f"[{index}/{total}] READY  {instance_id}", flush=True)
            continue
        pending.append((index, instance_id, initial_state))

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(pull_one, *item) for item in pending]
        for future in as_completed(futures):
            failure = future.result()
            if failure is not None:
                failures.append(failure)

    ready = sum(
        cache_state(cache_root, instance_id) == "ready"
        for instance_id in instance_ids
    )
    print(f"\nReady: {ready}/{total}; failed: {len(failures)}")
    if failures:
        for instance_id, error in failures:
            print(f"- {instance_id}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
