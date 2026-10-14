from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .config import Config

log = logging.getLogger("vibetrace.budget")

DEFAULT_DIFFICULTY = "1-4 hours"


@dataclass(frozen=True)
class Budget:
    usd: float
    time: float
    call: float


@dataclass(frozen=True)
class Pricing:
    in_hit: float = 0.0028
    in_miss: float = 0.14
    out: float = 0.28


DEFAULT_PRICING = Pricing()


class BudgetTable:
    def __init__(self):
        self._budgets: dict[str, Budget] = {}
        self._warned: set[str] = set()

        self.pricing: Pricing = DEFAULT_PRICING

    @classmethod
    def from_config(cls, cfg: "Config") -> "BudgetTable":
        budgets = cfg.get("budget.difficulty_budgets")
        if not budgets:
            raise ValueError(
                "budget requires budget.difficulty_budgets (per difficulty tier) in config."
            )
        bt = cls()
        for difficulty, b in budgets.items():
            bt._budgets[difficulty] = Budget(
                usd=float(b["usd"]), time=float(b["time"]), call=float(b["call"])
            )
        p = cfg.get("pricing")
        if p:
            bt.pricing = Pricing(
                in_hit=float(p.get("in_hit", DEFAULT_PRICING.in_hit)),
                in_miss=float(p.get("in_miss", DEFAULT_PRICING.in_miss)),
                out=float(p.get("out", DEFAULT_PRICING.out)),
            )
        return bt

    def get(self, difficulty: str) -> Budget:
        try:
            return self._budgets[difficulty]
        except KeyError:
            if DEFAULT_DIFFICULTY in self._budgets:
                if difficulty not in self._warned:
                    self._warned.add(difficulty)
                    log.warning(
                        "no budget for difficulty %r; falling back to %r",
                        difficulty,
                        DEFAULT_DIFFICULTY,
                    )
                return self._budgets[DEFAULT_DIFFICULTY]
            raise KeyError(f"no budget configured for difficulty {difficulty!r}")
