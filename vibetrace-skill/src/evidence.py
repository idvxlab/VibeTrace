from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .trace import Trace

EvidenceKind = Literal["single_success", "single_failure", "pair"]


@dataclass
class Evidence:
    kind: EvidenceKind
    instance: dict
    primary: Trace
    negative: Trace | None = None

    def all_traces(self) -> list[Trace]:
        ts = [self.primary]
        if self.negative is not None:
            ts.append(self.negative)
        return ts


def build_single(instance: dict, trace: Trace) -> Evidence:
    kind: EvidenceKind = "single_success" if trace.resolved else "single_failure"
    return Evidence(kind=kind, instance=instance, primary=trace)


def build_pair(instance: dict, negative: Trace, positive: Trace) -> Evidence:
    return Evidence(kind="pair", instance=instance, primary=positive, negative=negative)
