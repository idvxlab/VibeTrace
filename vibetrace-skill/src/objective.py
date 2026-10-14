from __future__ import annotations

from .budget import BudgetTable
from .trace import Trace


def usd_cost(trace: Trace, pricing) -> float:
    c = trace.cost
    if c.dollars > 0:
        return c.dollars
    miss = c.input_tokens + c.cache_write_tokens
    out = trace.c_out_tok
    hit = c.cache_read_tokens
    if hit == 0 and miss < trace.c_in_tok_cached:
        hit = trace.c_in_tok_cached - miss
    return (
        miss * pricing.in_miss + hit * pricing.in_hit + out * pricing.out
    ) / 1_000_000.0


def normalized_costs(trace: Trace, budgets: BudgetTable) -> tuple[float, float, float]:
    b = budgets.get(trace.difficulty)
    dollars = usd_cost(trace, budgets.pricing)
    c_usd = min(1.0, dollars / b.usd) if b.usd > 0 else 1.0
    c_time = min(1.0, trace.c_time / b.time) if b.time > 0 else 1.0
    c_call = min(1.0, trace.c_call / b.call) if b.call > 0 else 1.0
    return c_usd, c_time, c_call


def verifier_objective(trace: Trace, budgets: BudgetTable) -> float:
    r = 1.0 if trace.resolved else 0.0
    c_usd, c_time, c_call = normalized_costs(trace, budgets)
    return r * (1.0 - c_usd) * (1.0 - c_time) * (1.0 - c_call)
