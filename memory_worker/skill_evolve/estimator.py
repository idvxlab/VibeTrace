from __future__ import annotations

import logging
from dataclasses import dataclass

from .config import Config
from .evidence import Evidence
from .llm import LLMError, complete_json
from .prompt_context import evidence_digest
from .prompt_loader import load_prompt, render_template

log = logging.getLogger("vibetrace.estimator")

_SCORE_KEYS = ("reusable", "safe", "informative")


@dataclass
class EstimatorResult:
    passed: bool
    components: dict


def _validate(data: dict | list) -> None:
    if not isinstance(data, dict):
        raise LLMError("estimator expected a JSON object")
    if set(data) != set(_SCORE_KEYS):
        raise LLMError("estimator expected exactly reusable, safe, and informative")
    if not all(
        isinstance(data.get(key), (int, float))
        and not isinstance(data.get(key), bool)
        for key in _SCORE_KEYS
    ):
        raise LLMError(
            "estimator expected numeric reusable, safe, and informative scores"
        )


def _clamp_score(value: object) -> float:
    return max(0.0, min(1.0, float(value or 0.0)))


class TraceEstimator:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.model, self.variant, self.timeout = cfg.llm_settings("estimator")
        self.retries = int(cfg.get("estimator.retries", 2))
        self.reusable_min = float(cfg.get("estimator.reusable_min", 0.34))
        self.informative_min = float(cfg.get("estimator.informative_min", 0.50))
        risk_max = float(cfg.get("estimator.risk_max", 0.40))
        self.safe_min = 1.0 - max(0.0, min(1.0, risk_max))

    def _build_prompt(self, e: Evidence) -> str:
        return render_template(
            load_prompt("estimator_prompt.md", self.cfg),
            {"EVIDENCE_DIGEST": evidence_digest(e)},
        )

    def estimate(self, e: Evidence) -> EstimatorResult:
        if not self.model:
            return EstimatorResult(
                passed=False,
                components={
                    "reusable": 0.0,
                    "reusable_ok": False,
                    "safe": 0.0,
                    "safe_ok": False,
                    "informative": 0.0,
                    "informative_ok": False,
                    "reason": "no estimator model configured",
                    "source": "llm",
                },
            )
        try:
            data = complete_json(
                self._build_prompt(e),
                self.model,
                self.timeout,
                self.variant,
                retries=self.retries,
                validate=_validate,
            )
        except LLMError as ex:
            log.warning(
                "estimator LLM failed for %s (%s)",
                e.instance.get("instance_id", "?"),
                ex,
            )
            return EstimatorResult(
                passed=False,
                components={"reason": str(ex)[:500], "source": "llm_error"},
            )

        reusable = _clamp_score(data["reusable"])
        safe = _clamp_score(data["safe"])
        informative = _clamp_score(data["informative"])
        reusable_ok = reusable >= self.reusable_min
        safe_ok = safe >= self.safe_min
        informative_ok = informative >= self.informative_min
        return EstimatorResult(
            passed=reusable_ok and safe_ok and informative_ok,
            components={
                "reusable": reusable,
                "reusable_ok": reusable_ok,
                "safe": safe,
                "safe_ok": safe_ok,
                "informative": informative,
                "informative_ok": informative_ok,
            },
        )
