from __future__ import annotations

from .trace import Trace


def attach_feedback(trace: Trace, use_feedback: bool) -> Trace:
    trace.feedback["use_feedback"] = use_feedback
    if not use_feedback:
        trace.feedback["fork_role"] = None
        return trace

    trace.feedback.setdefault("fork_role", None)
    return trace
