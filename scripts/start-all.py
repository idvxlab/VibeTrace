#!/usr/bin/env python3
"""Launch the three VibeTrace processes detached from the current shell session."""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SERVICES = [
    ("opencode", ["opencode", "serve", "--port", "4096"]),
    ("worker", [sys.executable, "memory_worker/server.py"]),
    ("vite", ["npm", "run", "dev"]),
]

for name, cmd in SERVICES:
    log = open(f"/tmp/vibetrace-{name}.log", "ab", buffering=0)
    proc = subprocess.Popen(
        cmd,
        cwd=ROOT,
        stdout=log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    print(f"{name} pid={proc.pid} log=/tmp/vibetrace-{name}.log")
