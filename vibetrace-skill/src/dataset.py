from __future__ import annotations

import json
import logging
import random
from pathlib import Path

from .config import Config

log = logging.getLogger("vibetrace.dataset")

EXCLUDED_DIFFICULTIES = {">4 hours"}

KEEP_FIELDS = (
    "instance_id",
    "repo",
    "base_commit",
    "problem_statement",
    "patch",
    "test_patch",
    "FAIL_TO_PASS",
    "PASS_TO_PASS",
    "environment_setup_commit",
    "version",
    "hints_text",
    "difficulty",
)


def filter_by_difficulty(cfg: Config, rows: list[dict]) -> list[dict]:
    keep = cfg.get("dataset.difficulty_in", None)
    if not keep:
        return rows
    keep_set = set(keep)
    out = [r for r in rows if r.get("difficulty") in keep_set]
    if not out:
        raise ValueError(
            f"dataset.difficulty_in={keep} matched 0 records; "
            f"valid labels are '<15 min fix', '15 min - 1 hour', '1-4 hours', '>4 hours'."
        )
    return out


def cache_path(cfg: Config) -> Path:
    cache_dir = cfg.resolve("dataset.cache_dir")
    cache_dir.mkdir(parents=True, exist_ok=True)
    name = cfg.get("dataset.name").replace("/", "__")
    split = cfg.get("dataset.split")
    return cache_dir / f"{name}__{split}.json"


def load_full(cfg: Config) -> list[dict]:
    cache = cache_path(cfg)
    if cache.exists():
        rows = json.loads(cache.read_text(encoding="utf-8"))
        return filter_by_difficulty(cfg, rows)

    parquet = find_parquet(cfg)
    if parquet is None:
        raise FileNotFoundError(
            f"Dataset cache not found: {cache}. "
            f"No parquet file found in {cfg.resolve('dataset.cache_dir')} either. "
            f"Place a SWE-bench Verified parquet file in that directory, "
            f"or point dataset.cache_dir at the vibetrace data directory (e.g. ../data/swe-bench-verified)."
        )
    return load_from_parquet(parquet, cache, cfg)


def find_parquet(cfg: Config) -> Path | None:
    cache_dir = cfg.resolve("dataset.cache_dir")
    if not cache_dir.exists():
        return None
    candidates = sorted(cache_dir.glob("*.parquet"))
    return candidates[0] if candidates else None


def load_from_parquet(parquet: Path, json_cache: Path, cfg: Config) -> list[dict]:
    try:
        import pandas as pd
    except ImportError:
        raise ImportError(
            "Reading parquet requires pandas. Activate the vibetrace virtualenv:\n"
            "source /path/to/.venvs/vibetrace/bin/activate"
        )

    df = pd.read_parquet(parquet)
    cols = [c for c in KEEP_FIELDS if c in df.columns]
    df = df[cols]

    def to_list(x):
        if isinstance(x, str):
            try:
                return json.loads(x)
            except Exception:
                return []
        if hasattr(x, "tolist"):
            return x.tolist()
        return list(x) if x is not None else []

    for col in ("FAIL_TO_PASS", "PASS_TO_PASS"):
        if col not in df.columns:
            continue
        df[col] = df[col].apply(to_list)

    rows = df.where(df.notna(), other=None).to_dict(orient="records")

    json_cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = json_cache.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(json_cache)
    print(f"[dataset] converted {len(rows)} instances from {parquet} to {json_cache}")
    return filter_by_difficulty(cfg, rows)


def load_split_file(cfg: Config) -> dict | None:
    raw = cfg.get("dataset.split_file", None)
    if not raw:
        return None
    path = cfg.resolve("dataset.split_file")
    if not path.exists():
        raise FileNotFoundError(f"dataset.split_file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def stratified_sample(
    ids: list[str],
    by_id: dict[str, dict],
    ratio: float,
    rng: random.Random,
) -> list[str]:
    groups: dict[str, list[str]] = {}
    for i in ids:
        diff = by_id[i].get("difficulty") or "unknown"
        groups.setdefault(diff, []).append(i)
    picked: list[str] = []
    for diff in sorted(groups):
        items = list(groups[diff])
        rng.shuffle(items)
        n_sample = max(1, round(len(items) * ratio))
        picked.extend(items[:n_sample])
    return picked


def sample_train_side(
    train_ids: list[str],
    by_id: dict[str, dict],
    ratio: float,
    rng: random.Random,
    cluster_of: dict[str, str],
    test_sample: list[str],
) -> list[str]:
    groups: dict[str, list[str]] = {}
    diff_of: dict[str, str] = {}
    for i in train_ids:
        diff = by_id[i].get("difficulty") or "unknown"
        diff_of[i] = diff
        groups.setdefault(diff, []).append(i)
    quota: dict[str, int] = {}
    for diff in sorted(groups):
        rng.shuffle(groups[diff])
        quota[diff] = max(1, round(len(groups[diff]) * ratio))

    members: dict[str, list[str]] = {}
    for diff in sorted(groups):
        for i in groups[diff]:
            ck = cluster_of.get(i)
            if ck:
                members.setdefault(ck, []).append(i)

    picked: list[str] = []
    picked_set: set[str] = set()
    used = {d: 0 for d in quota}

    target_clusters = list(
        dict.fromkeys(cluster_of.get(tid) for tid in test_sample if cluster_of.get(tid))
    )
    target_n = sum(quota.values())
    for ck in target_clusters[:target_n]:
        candidates = [i for i in members.get(ck, []) if i not in picked_set]
        if not candidates:
            continue
        cand = min(
            candidates,
            key=lambda i: (
                used[diff_of[i]] >= quota[diff_of[i]],
                used[diff_of[i]] / quota[diff_of[i]],
            ),
        )
        d = diff_of[cand]
        picked.append(cand)
        picked_set.add(cand)
        used[d] += 1

    for diff in sorted(groups):
        rest = [i for i in groups[diff] if i not in picked_set]
        rest.sort(key=lambda i: cluster_of.get(i) not in target_clusters)
        need = max(0, quota[diff] - used[diff])
        chosen = rest[:need]
        picked.extend(chosen)
        picked_set.update(chosen)

    if len(picked) < target_n:
        rest = [i for diff in sorted(groups) for i in groups[diff] if i not in picked_set]
        picked.extend(rest[: target_n - len(picked)])
    return picked[:target_n]


def sample_split(cfg: Config) -> tuple[list[dict], list[dict]]:
    rows = load_full(cfg)
    rows = [r for r in rows if r.get("difficulty") not in EXCLUDED_DIFFICULTIES]
    seed = cfg.get("dataset.shuffle_seed", 42)
    rng = random.Random(seed)
    sample_ratio = float(cfg.get("dataset.sample_ratio", 0.10))
    train_sample_ratio = float(cfg.get("dataset.train_sample_ratio", sample_ratio))
    test_sample_ratio = float(cfg.get("dataset.test_sample_ratio", sample_ratio))

    split_data = load_split_file(cfg)
    if split_data is None:
        return legacy_sample_split(cfg, rows, rng, sample_ratio)

    by_id = {r["instance_id"]: r for r in rows}
    train_ids = [i for i in split_data["train"] if i in by_id]
    test_ids = [i for i in split_data["test"] if i in by_id]

    cluster_of: dict[str, str] = {}
    for ckey, ids in (split_data.get("clusters") or {}).items():
        for i in ids:
            cluster_of[i] = ckey

    test_sample = stratified_sample(test_ids, by_id, test_sample_ratio, rng)
    train_sample = sample_train_side(
        train_ids, by_id, train_sample_ratio, rng, cluster_of, test_sample
    )

    train_clusters = {cluster_of.get(i) for i in train_sample}
    covered = sum(1 for i in test_sample if cluster_of.get(i) in train_clusters)
    log.info(
        "[split] file=%s train=%d test=%d | test tasks with a same-cluster "
        "train sibling: %d/%d",
        cfg.get("dataset.split_file"),
        len(train_sample),
        len(test_sample),
        covered,
        len(test_sample),
    )
    return [by_id[i] for i in train_sample], [by_id[i] for i in test_sample]


def legacy_sample_split(
    cfg: Config,
    rows: list[dict],
    rng: random.Random,
    sample_ratio: float,
) -> tuple[list[dict], list[dict]]:
    train_ratio = float(cfg.get("dataset.train_ratio", 0.50))

    groups: dict[str, list[dict]] = {}
    for r in rows:
        diff = r.get("difficulty") or "unknown"
        groups.setdefault(diff, []).append(r)

    distill: list[dict] = []
    test: list[dict] = []
    for diff in sorted(groups):
        items = list(groups[diff])
        rng.shuffle(items)
        n_sample = max(1, round(len(items) * sample_ratio))
        sampled = items[:n_sample]
        n_train = round(len(sampled) * train_ratio)
        distill.extend(sampled[:n_train])
        test.extend(sampled[n_train:])
    return distill, test


def cluster_stream(cfg: Config, rows: list[dict]) -> list[dict]:
    split_data = load_split_file(cfg) or {}
    cluster_of: dict[str, str] = {}
    for ckey, ids in (split_data.get("clusters") or {}).items():
        for instance_id in ids:
            cluster_of[instance_id] = ckey
    groups: dict[str, list[dict]] = {}
    for r in rows:
        key = cluster_of.get(r["instance_id"], r["repo"])
        groups.setdefault(key, []).append(r)
    return [r for cluster in groups.values() for r in cluster]


def split(cfg: Config) -> tuple[list[dict], list[dict]]:
    distill, test = sample_split(cfg)
    seed = cfg.get("dataset.shuffle_seed", 42)
    rng = random.Random(seed)
    rng.shuffle(distill)
    rng.shuffle(test)
    if cfg.get("dataset.subsystem_clustered_stream", True):
        distill = cluster_stream(cfg, distill)
    return distill, test
