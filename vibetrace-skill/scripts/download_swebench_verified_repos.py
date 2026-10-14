from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import pandas as pd

DEFAULT_DATASET = Path("data/swe-bench-verified/test-00000-of-00001.parquet")
DEFAULT_REPOS_DIR = Path("repos/swe-bench-verified")


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def repo_dir_name(repo: str) -> str:
    return repo.replace("/", "__")


def load_repos(dataset_path: Path) -> list[str]:
    if not dataset_path.exists():
        raise FileNotFoundError(
            f"Dataset parquet not found: {dataset_path}\n"
            "Download it first or pass --dataset-path."
        )
    df = pd.read_parquet(dataset_path, columns=["repo"])
    return sorted(df["repo"].drop_duplicates().tolist())


def clone_or_update(repo: str, repos_dir: Path, update: bool) -> None:
    target = repos_dir / repo_dir_name(repo)
    url = f"https://github.com/{repo}.git"

    if target.exists():
        if not (target / ".git").exists():
            raise RuntimeError(f"Target exists but is not a git repo: {target}")
        if update:
            run(["git", "fetch", "--all", "--tags", "--prune"], cwd=target)
        else:
            print(f"skip existing: {target}")
        return

    run(["git", "clone", url, str(target)])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset-path",
        type=Path,
        default=DEFAULT_DATASET,
        help=f"Path to SWE-bench Verified parquet file. Default: {DEFAULT_DATASET}",
    )
    parser.add_argument(
        "--repos-dir",
        type=Path,
        default=DEFAULT_REPOS_DIR,
        help=f"Directory where repositories are cloned. Default: {DEFAULT_REPOS_DIR}",
    )
    parser.add_argument(
        "--update",
        action="store_true",
        help="Fetch updates for repositories that already exist.",
    )
    parser.add_argument(
        "--list-only",
        action="store_true",
        help="Only print repositories and target paths; do not clone.",
    )
    args = parser.parse_args()

    repos = load_repos(args.dataset_path)
    print(f"Found {len(repos)} unique repos in {args.dataset_path}:")
    for repo in repos:
        print(f"  {repo} -> {args.repos_dir / repo_dir_name(repo)}")

    if args.list_only:
        return 0

    args.repos_dir.mkdir(parents=True, exist_ok=True)
    for repo in repos:
        clone_or_update(repo, args.repos_dir, args.update)

    print(f"Done. Repositories are under: {args.repos_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(
            f"Command failed with exit code {exc.returncode}: {exc.cmd}",
            file=sys.stderr,
        )
        raise SystemExit(exc.returncode)
