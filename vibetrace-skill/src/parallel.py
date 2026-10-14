from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable

from .skillpool import SkillPool
from .trace import Trace


def run_tasks(
    runner,
    jobs: list[tuple[dict, SkillPool]],
    concurrency: int,
    cleanup: bool = True,
    on_done: Callable[[int, Trace], None] | None = None,
) -> list[Trace]:
    n = len(jobs)
    results: list[Trace | None] = [None] * n

    def run_one(i: int) -> tuple[int, Trace]:
        inst, pool = jobs[i]
        t = runner.run_task(inst, pool, run_id=uuid.uuid4().hex[:8], cleanup=cleanup)
        return i, t

    if concurrency <= 1 or n <= 1:
        for i in range(n):
            _, t = run_one(i)
            results[i] = t
            if on_done:
                on_done(i, t)
    else:
        with ThreadPoolExecutor(max_workers=min(concurrency, n)) as ex:
            futures = [ex.submit(run_one, i) for i in range(n)]
            for fut in as_completed(futures):
                i, t = fut.result()
                results[i] = t
                if on_done:
                    on_done(i, t)
    return results
