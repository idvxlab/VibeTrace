from __future__ import annotations

import contextlib
import fcntl
import gzip
import hashlib
import http.client
import json
import os
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from swebench.harness.grading import get_eval_report
from swebench.harness.test_spec.test_spec import make_test_spec

_MANIFEST_ACCEPT = ",".join(
    [
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.index.v1+json",
    ]
)
_WHITEOUT = ".wh."
_OPAQUE = ".wh..wh..opq"

_ENTRYPOINT = """\
#!/bin/bash
exec > /test_output.log 2>&1
export PATH=/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=Etc/UTC
cd /testbed || exit 1
git reset --hard {base_commit} -q 2>/dev/null
git clean -fdxq 2>/dev/null
applied=0
for cmd in "git apply --verbose" "git apply --verbose --reject" "patch --batch --fuzz=5 -p1 -i"; do
  if $cmd /tmp/patch.diff; then applied=1; break; fi
done
echo "[crun-backend] model patch applied=$applied"
bash /eval.sh
"""


class CrunBackend:
    def __init__(self, cfg):
        self.cfg = cfg
        self.rootfs_cache = cfg.resolve(
            "evaluator.crun.rootfs_cache", "data/swe-bench-verified/crun-rootfs"
        )
        self.namespace = cfg.get("evaluator.crun.image_namespace", "swebench")
        self.arch = cfg.get("evaluator.crun.arch", "x86_64")
        self.timeout = int(cfg.get("evaluator.timeout_sec", 3600))

        self.net_timeout = int(cfg.get("evaluator.crun.net_timeout_sec", 120))
        self.pull_deadline = int(cfg.get("evaluator.crun.pull_deadline_sec", 1800))

        self.proxy = cfg.get("evaluator.crun.proxy") or os.environ.get(
            "HTTPS_PROXY", ""
        )
        self.registry = cfg.get("evaluator.crun.registry", "registry-1.docker.io")
        self.registry_auth = cfg.get(
            "evaluator.crun.registry_auth", "https://auth.docker.io/token"
        )
        self.auth_service = cfg.get("evaluator.crun.auth_service", "registry.docker.io")
        configured_blob_cache = cfg.get("evaluator.crun.blob_cache")
        self.blob_cache = (
            cfg.resolve("evaluator.crun.blob_cache")
            if configured_blob_cache
            else self.rootfs_cache / ".blobs"
        )
        self.rootfs_cache.mkdir(parents=True, exist_ok=True)
        self.blob_cache.mkdir(parents=True, exist_ok=True)

    def _repo(self, instance_id: str) -> str:
        slug = instance_id.replace("__", "_1776_").lower()
        return f"{self.namespace}/sweb.eval.{self.arch}.{slug}"

    def ensure_rootfs(self, instance_id: str) -> Path:
        dest = self.rootfs_cache / instance_id
        work = dest / ".pull_tmp"
        if (dest / "rootfs" / "testbed").exists() and not work.exists():
            return dest
        if dest.exists():
            shutil.rmtree(dest)
        rootfs = dest / "rootfs"
        rootfs.mkdir(parents=True, exist_ok=True)
        try:
            self._extract_image(self._repo(instance_id), rootfs)
        except Exception as exc:
            raise RuntimeError(
                f"crun backend: failed to fetch rootfs for {instance_id}: {exc}"
            ) from exc
        if not (rootfs / "testbed").exists():
            raise RuntimeError(
                f"crun backend: image for {instance_id} has no /testbed after extraction"
            )
        return dest

    def _urlopen(
        self,
        url: str,
        headers: dict,
        binary_to: Path | None = None,
        resume_from: int = 0,
    ):
        proxy = self.proxy
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler(
                {"http": proxy, "https": proxy} if proxy else {}
            )
        )
        req = urllib.request.Request(url, headers=headers)
        with opener.open(req, timeout=self.net_timeout) as resp:
            if binary_to is not None:
                status = getattr(resp, "status", None) or resp.getcode()
                self._copy_with_deadline(
                    resp,
                    binary_to,
                    append=resume_from > 0 and status == 206,
                )
                return None
            return resp.read()

    def _copy_with_deadline(self, resp, dest: Path, *, append: bool = False) -> None:
        deadline = time.monotonic() + self.pull_deadline
        with open(dest, "ab" if append else "wb") as fh:
            for chunk in iter(lambda: resp.read1(1 << 20), b""):
                fh.write(chunk)
                if time.monotonic() > deadline:
                    raise TimeoutError(
                        f"blob download exceeded {self.pull_deadline}s deadline"
                    )

    def _download_blob(
        self, repo: str, layer: dict, hdr: dict, attempts: int = 4
    ) -> Path:
        digest = layer["digest"]
        want_size = layer.get("size")
        algo, _, want_hex = digest.partition(":")
        if not algo or not want_hex:
            raise RuntimeError(f"invalid blob digest: {digest}")
        cache_dir = self.blob_cache / algo
        cache_dir.mkdir(parents=True, exist_ok=True)
        cached = cache_dir / want_hex
        partial = cache_dir / f"{want_hex}.part"
        lock_path = cache_dir / f"{want_hex}.lock"
        url = f"https://{self.registry}/v2/{repo}/blobs/{digest}"
        with open(lock_path, "a+b") as lock_fh:
            fcntl.flock(lock_fh, fcntl.LOCK_EX)
            if cached.is_file() and (
                want_size is None or cached.stat().st_size == want_size
            ):
                return cached
            cached.unlink(missing_ok=True)
            if (
                partial.exists()
                and want_size is not None
                and partial.stat().st_size > want_size
            ):
                partial.unlink()

            if (
                partial.is_file()
                and want_size is not None
                and partial.stat().st_size == want_size
            ):
                if self._blob_matches(partial, algo, want_hex):
                    os.replace(partial, cached)
                    return cached
                partial.unlink()

            last = None
            headers = dict(hdr)
            for attempt in range(attempts):
                offset = partial.stat().st_size if partial.exists() else 0
                request_headers = dict(headers)
                if offset:
                    request_headers["Range"] = f"bytes={offset}-"
                try:
                    self._urlopen(
                        url,
                        request_headers,
                        binary_to=partial,
                        resume_from=offset,
                    )
                except urllib.error.HTTPError as exc:
                    last = f"network error: {exc}"
                    if exc.code in (401, 403):
                        headers = {
                            "Authorization": f"Bearer {self._auth_token(repo)}"
                        }
                    time.sleep(min(2**attempt, 30))
                    continue
                except (OSError, http.client.HTTPException) as exc:
                    last = f"network error: {exc}"
                    time.sleep(min(2**attempt, 30))
                    continue

                got_size = partial.stat().st_size
                if want_size is not None and got_size != want_size:
                    last = f"size {got_size} != {want_size}"
                    if got_size > want_size:
                        partial.unlink()
                    time.sleep(min(2**attempt, 30))
                    continue
                if self._blob_matches(partial, algo, want_hex):
                    os.replace(partial, cached)
                    return cached
                last = f"{algo} digest does not match {want_hex[:12]}"
                partial.unlink(missing_ok=True)
                time.sleep(min(2**attempt, 30))
        raise RuntimeError(
            f"blob {digest[:19]} corrupt after {attempts} tries ({last})"
        )

    @staticmethod
    def _blob_matches(path: Path, algo: str, want_hex: str) -> bool:
        h = hashlib.new(algo)
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest() == want_hex

    def _auth_token(self, repo: str) -> str:
        url = (
            f"{self.registry_auth}?service={self.auth_service}"
            f"&scope=repository:{repo}:pull"
        )
        data = json.loads(self._urlopen(url, {}))
        return data.get("token") or data.get("access_token") or ""

    def _resolve_manifest(self, repo: str, ref: str, token: str) -> dict:
        hdr = {"Authorization": f"Bearer {token}", "Accept": _MANIFEST_ACCEPT}
        man = json.loads(
            self._urlopen(f"https://{self.registry}/v2/{repo}/manifests/{ref}", hdr)
        )
        if man.get("manifests"):
            digest = next(
                (
                    m["digest"]
                    for m in man["manifests"]
                    if m.get("platform", {}).get("os") == "linux"
                    and m.get("platform", {}).get("architecture") == "amd64"
                ),
                man["manifests"][0]["digest"],
            )
            man = json.loads(
                self._urlopen(
                    f"https://{self.registry}/v2/{repo}/manifests/{digest}", hdr
                )
            )
        return man

    def _extract_image(self, repo: str, rootfs: Path) -> None:
        repo, _, tag = repo.partition(":")
        tag = tag or "latest"
        token = self._auth_token(repo)
        manifest = self._resolve_manifest(repo, tag, token)
        layers = manifest.get("layers")
        if not layers:
            raise RuntimeError(f"no layers in manifest (keys={list(manifest)})")
        hdr = {"Authorization": f"Bearer {token}"}
        work = rootfs.parent / ".pull_tmp"
        if work.exists():
            shutil.rmtree(work)
        work.mkdir(parents=True)
        try:
            for i, layer in enumerate(layers):
                blob = self._download_blob(repo, layer, hdr)
                layer_dir = work / f"layer{i}"
                layer_dir.mkdir()
                opener = gzip.open if self._is_gzip(blob) else open
                with opener(blob, "rb") as raw, tarfile.open(
                    fileobj=raw, mode="r|*"
                ) as tar:
                    tar.errorlevel = 0
                    tar.extractall(layer_dir, numeric_owner=True)
                self._apply_whiteouts(layer_dir, rootfs)
                self._merge(layer_dir, rootfs)
                shutil.rmtree(layer_dir, ignore_errors=True)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @staticmethod
    def _is_gzip(path: Path) -> bool:
        with open(path, "rb") as fh:
            return fh.read(2) == b"\x1f\x8b"

    @classmethod
    def _apply_whiteouts(cls, layer_dir: Path, rootfs: Path) -> None:
        for marker in list(layer_dir.rglob(f"{_WHITEOUT}*")):
            rel = marker.relative_to(layer_dir)
            if marker.name == _OPAQUE:
                target_dir = rootfs / rel.parent
                if target_dir.is_dir():
                    for child in target_dir.iterdir():
                        cls._rmtree(child)
            else:
                cls._rmtree(rootfs / rel.parent / marker.name[len(_WHITEOUT) :])
            cls._rmtree(marker)

    @staticmethod
    def _rmtree(p: Path) -> None:
        if p.is_symlink() or p.is_file():
            p.unlink(missing_ok=True)
        elif p.is_dir():
            shutil.rmtree(p, ignore_errors=True)

    @classmethod
    def _merge(cls, src: Path, dst: Path) -> None:
        for item in src.iterdir():
            target = dst / item.name
            if item.is_dir() and not item.is_symlink():
                if target.is_dir() and not target.is_symlink():
                    cls._merge(item, target)
                    continue
                cls._rmtree(target)
            else:
                cls._rmtree(target)
            shutil.move(str(item), str(target))

    _DEV_NODES = [
        ("null", 1, 3),
        ("zero", 1, 5),
        ("full", 1, 7),
        ("random", 1, 8),
        ("urandom", 1, 9),
        ("tty", 5, 0),
    ]

    def _prepare_dev(self, rootfs: Path) -> None:
        for d in ("proc", "sys", "dev", "dev/pts", "dev/shm", "tmp"):
            (rootfs / d).mkdir(parents=True, exist_ok=True)
        for name, major, minor in self._DEV_NODES:
            node = rootfs / "dev" / name
            if not node.exists():
                subprocess.run(
                    ["mknod", "-m", "666", str(node), "c", str(major), str(minor)],
                    check=False,
                    capture_output=True,
                )
        hosts = rootfs / "etc" / "hosts"
        hosts.parent.mkdir(exist_ok=True)
        if not (hosts.exists() and hosts.read_text().strip()):
            hosts.write_text("127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost\n")

    def _stage_files(
        self, rootfs: Path, test_spec, instance: dict, model_patch: str
    ) -> Path:
        self._prepare_dev(rootfs)
        (rootfs / "eval.sh").write_text(test_spec.eval_script)
        (rootfs / "tmp").mkdir(exist_ok=True)
        (rootfs / "tmp" / "patch.diff").write_text(model_patch or "")
        (rootfs / "entrypoint.sh").write_text(
            _ENTRYPOINT.format(base_commit=instance["base_commit"])
        )
        log_path = rootfs / "test_output.log"
        log_path.unlink(missing_ok=True)
        return log_path

    _CHROOT_ENV = {
        "PATH": "/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/root",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "Etc/UTC",
    }

    def _run_chroot(self, rootfs: Path) -> None:
        proc = subprocess.Popen(
            ["chroot", str(rootfs), "/bin/bash", "/entrypoint.sh"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=self._CHROOT_ENV,
            start_new_session=True,
        )
        try:
            proc.wait(timeout=self.timeout)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            raise

    def grade(self, instance: dict, model_patch: str) -> bool:
        instance_id = instance["instance_id"]
        test_spec = make_test_spec(instance)
        rootfs = self.ensure_rootfs(instance_id) / "rootfs"

        log_path = self._stage_files(rootfs, test_spec, instance, model_patch)

        self._run_chroot(rootfs)

        if not log_path.exists():
            raise RuntimeError(
                f"crun backend: no test output produced for {instance_id}"
            )

        prediction = {
            "instance_id": instance_id,
            "model_name_or_path": "vibetrace",
            "model_patch": model_patch or "",
        }
        with tempfile.TemporaryDirectory() as td:
            tmp_log = Path(td) / "test_output.log"
            tmp_log.write_text(log_path.read_text(errors="replace"))
            report = get_eval_report(
                test_spec=test_spec,
                prediction=prediction,
                test_log_path=str(tmp_log),
                include_tests_status=True,
            )
        return bool(report.get(instance_id, {}).get("resolved", False))
