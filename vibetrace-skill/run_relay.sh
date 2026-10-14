#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

VENV_DIR="$HERE/../.venvs/vibetrace"
if [[ -f "$VENV_DIR/bin/activate" ]]; then
  source "$VENV_DIR/bin/activate"
else
  echo "vibetrace venv not found at $VENV_DIR (create it per README 'Installation' first)" >&2
  exit 1
fi

export OPENCODE_CONFIG="$HERE/opencode.relay.jsonc"

export SE_EVAL_BACKEND="${SE_EVAL_BACKEND:-crun}"
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"

if [[ -f "$HERE/.relay_key" ]]; then
  source "$HERE/.relay_key"
else
  echo "missing $HERE/.relay_key (should contain: export DEEPSEEK_API_KEYS='sk-1,sk-2,...')" >&2
  exit 1
fi

if [[ "${SE_NO_CLEAN:-0}" != "1" ]]; then
  echo "[clean] clearing leftovers from prior interrupted runs (SE_NO_CLEAN=1 to skip)..."

  pkill -f 'bin/evolve' 2>/dev/null || true
  pkill -f 'opencode run --format json' 2>/dev/null || true

  if command -v docker >/dev/null 2>&1; then
    cids="$(docker ps -aq --filter name=se_probe 2>/dev/null || true)"
    [[ -n "$cids" ]] && docker rm -f $cids >/dev/null 2>&1 || true
  fi

  ocdata="$(readlink -f "${XDG_DATA_HOME:-$HOME/.local/share}/opencode" 2>/dev/null || true)"
  if [[ -n "$ocdata" && -d "$ocdata" ]]; then
    find "$ocdata" -mindepth 1 -maxdepth 1 \
      ! -name bin ! -name repos \
      -exec rm -rf {} +
  fi
  rm -rf /tmp/vibetrace_workspaces/.opencode_state 2>/dev/null || true

  base_python="$("$VIRTUAL_ENV/bin/python" -S -c 'import sys; print(sys._base_executable)')"
  "$base_python" - "$VIRTUAL_ENV" <<'PY' || true
import sys, re, site, glob, os, shutil
sp_dirs = set(site.getsitepackages()) if hasattr(site, "getsitepackages") else set()
sp_dirs.add(os.path.join(sys.argv[1], "lib"))
sp_dirs.add(site.getusersitepackages())
for base in list(sp_dirs):
    for sp in glob.glob(os.path.join(base, "python*", "site-packages")) + [base]:
        if not os.path.isdir(sp):
            continue
        for f in glob.glob(os.path.join(sp, "*.pth")) + \
                 glob.glob(os.path.join(sp, "*.pth.bak")) + \
                 glob.glob(os.path.join(sp, "*.pth.fixed")) + \
                 glob.glob(os.path.join(sp, "*.egg-link")):
            try:
                txt = open(f, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            m = re.search(r"/tmp/vibetrace_workspaces/[^/'\"\s]+", txt)
            if m:
                os.remove(f)
                print(f"[clean] removed contaminated {os.path.basename(f)}")
        for f in glob.glob(os.path.join(sp, "__editable__*_finder.py")):
            try:
                txt = open(f, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            m = re.search(r"/tmp/vibetrace_workspaces/[^/'\"\s]+", txt)
            if m:
                for pth in glob.glob(os.path.join(sp, "__editable__*.pth")):
                    ptxt = open(pth, encoding="utf-8", errors="ignore").read()
                    if os.path.basename(f)[:-3] in ptxt:
                        os.remove(pth)
                        print(f"[clean] removed contaminated {os.path.basename(pth)}")
                os.remove(f)
                print(f"[clean] removed contaminated {os.path.basename(f)}")
        for di in glob.glob(os.path.join(sp, "*.dist-info")):
            rec = os.path.join(di, "direct_url.json")
            if os.path.exists(rec) and "vibetrace_workspaces" in open(rec, errors="ignore").read():
                shutil.rmtree(di, ignore_errors=True)
                print(f"[clean] removed contaminated {os.path.basename(di)}")
PY

  echo "[clean] done."
fi

if [[ "${SE_NO_LOG:-0}" == "1" ]]; then
  exec evolve "$@"
else
  LOG_DIR="${SE_LOG_DIR:-$HERE/logs}"
  mkdir -p "$LOG_DIR"
  LOG_FILE="$LOG_DIR/relay_$(date +%Y%m%d_%H%M%S).log"
  echo "[log] saving terminal output to $LOG_FILE"
  evolve "$@" 2>&1 | tee "$LOG_FILE"
fi
