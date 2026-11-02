from __future__ import annotations

import logging
import re

from .config import Config
from .evidence import Evidence
from .llm import LLMError, complete_json
from .prompt_context import evidence_digest, inline_preview, pool_details, pool_digest
from .prompt_loader import load_prompt, render_template
from .skillpool import (
    MAX_SKILL_DESCRIPTION_CHARS,
    MAX_SKILL_NAME_CHARS,
    PatchOp,
    SkillPool,
    one_line,
)

log = logging.getLogger("vibetrace.distiller")

_MAX_SKILL_CHARS = 3000

_SCORER_KEYS = (
    "reuse",
    "correctness",
    "token_r",
    "time_r",
    "call_r",
)
_RELATIVE_KEYS = {
    "save_tokens": "token_r",
    "save_time": "time_r",
    "save_calls": "call_r",
}
_ALLOWED_OPS = frozenset({"create", "revise", "merge", "remove"})


def _geometric_mean(values: tuple[float, ...]) -> float:
    product = 1.0
    for value in values:
        product *= value
    return product ** (1.0 / len(values))


def _aggregate_score(
    entry: dict,
    reuse_gate_min: float,
    correctness_gate_min: float,
) -> tuple[float, dict]:
    dims = {
        key: float(max(0.0, min(1.0, entry.get(key, 0.0) or 0.0)))
        for key in ("reuse", "correctness")
    }
    relative = {
        raw_key: float(max(-1.0, min(1.0, entry.get(raw_key, 0.0) or 0.0)))
        for raw_key in _RELATIVE_KEYS.values()
    }
    savings = {
        score_key: max(0.0, relative[raw_key])
        for score_key, raw_key in _RELATIVE_KEYS.items()
    }
    efficiency = _geometric_mean(
        (
            savings["save_tokens"],
            savings["save_time"],
            savings["save_calls"],
        )
    )
    reuse_gate = 1.0 if dims["reuse"] >= reuse_gate_min else 0.0
    correctness_gate = (
        1.0 if dims["correctness"] >= correctness_gate_min else 0.0
    )
    cost_gate = all(value > 0.0 for value in relative.values())
    eligible = bool(reuse_gate and correctness_gate and cost_gate)
    dims["eligible"] = eligible
    dims.update(relative)
    dims.update(savings)
    dims["efficiency"] = efficiency
    return efficiency if eligible else 0.0, dims


def _score_entries(data: dict | list) -> list:
    if isinstance(data, dict):
        return data.get("scores", [])
    return data if isinstance(data, list) else []


def _valid_score(entry: object) -> bool:
    return (
        isinstance(entry, dict)
        and isinstance(entry.get("index"), int)
        and not isinstance(entry.get("index"), bool)
        and all(
            isinstance(entry.get(k), (int, float))
            and not isinstance(entry.get(k), bool)
            for k in _SCORER_KEYS
        )
    )


def _candidate_items(data: dict | list) -> list:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        items = data.get("candidates", data.get("ops"))
        if isinstance(items, list):
            return items
    raise LLMError("distiller expected a candidates array")


def _valid_name(value: object) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= MAX_SKILL_NAME_CHARS
        and re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value) is not None
    )


def _has_skip_cue(value: object) -> bool:
    return isinstance(value, str) and re.search(
        r"\b(?:skip when|do not use when)\b", value, re.IGNORECASE
    ) is not None


def _has_skip_section(value: object) -> bool:
    return isinstance(value, str) and re.search(
        r"(?im)^##\s+(?:skip|do not use when)\s*$", value
    ) is not None


def _make_validate_candidates(
    max_content_chars: int, max_candidates: int | None = None
):
    def _validate(data: dict | list) -> None:
        items = _candidate_items(data)
        if max_candidates is not None and len(items) > max_candidates:
            raise LLMError(f"distiller returned more than {max_candidates} candidates")
        for item in items:
            if not isinstance(item, dict) or item.get("op") not in _ALLOWED_OPS:
                raise LLMError("candidate has an invalid operation")
            op = item["op"]
            name = item.get("name")
            desc = item.get("description")
            content = item.get("content")
            target = item.get("target_id")
            merge_ids = item.get("merge_ids")
            if op in ("create", "merge") and not _valid_name(name):
                raise LLMError(
                    "create/merge name must match [a-z0-9-] and be <=64 chars"
                )
            if op in ("create", "merge") and not (
                isinstance(desc, str) and one_line(desc)
            ):
                raise LLMError("create/merge requires a non-empty description")
            if op in ("create", "merge") and not _has_skip_cue(desc):
                raise LLMError(
                    "create/merge description requires a pre-action 'Skip when' cue"
                )
            if op in ("create", "merge") and not (
                isinstance(content, str) and content.strip()
            ):
                raise LLMError("create/merge requires non-empty content")
            if op in ("create", "merge") and not _has_skip_section(content):
                raise LLMError("create/merge content requires a '## Skip' section")
            if isinstance(content, str) and len(content.strip()) > max_content_chars:
                raise LLMError(f"content exceeds {max_content_chars} characters")
            if op == "revise" and not (
                isinstance(target, str)
                and target
                and (
                    _valid_name(name)
                    or (isinstance(desc, str) and one_line(desc))
                    or (isinstance(content, str) and content.strip())
                )
            ):
                raise LLMError(
                    "revise requires target_id and a non-empty changed field"
                )
            if (
                op == "revise"
                and isinstance(desc, str)
                and desc
                and not _has_skip_cue(desc)
            ):
                raise LLMError(
                    "revised description requires a pre-action 'Skip when' cue"
                )
            if (
                op == "revise"
                and isinstance(content, str)
                and content
                and not _has_skip_section(content)
            ):
                raise LLMError("revised content requires a '## Skip' section")
            if op == "remove" and not (isinstance(target, str) and target):
                raise LLMError("remove requires target_id")
            if op == "merge" and not (
                isinstance(merge_ids, list)
                and len(merge_ids) >= 2
                and len(set(merge_ids)) == len(merge_ids)
                and all(isinstance(x, str) and x for x in merge_ids)
            ):
                raise LLMError("merge requires at least two distinct merge_ids")

    return _validate


def _make_validate_scores(n: int):
    schema = (
        "scorer expected {'scores':[{'index':int,'reuse':float,'correctness':float,"
        "'token_r':float,'time_r':float,'call_r':float},...]} "
        f"with exactly one valid score per candidate index 0..{n - 1} "
    )

    def _validate(data: dict | list) -> None:
        indices = []
        for entry in _score_entries(data):
            if not _valid_score(entry):
                raise LLMError(schema)
            indices.append(entry["index"])

        if sorted(indices) != list(range(n)):
            raise LLMError(schema)

    return _validate


def _make_validate_pool_selection(max_count: int, allowed_ids: set[str]):
    def _validate(data: dict | list) -> None:
        if not isinstance(data, dict):
            raise LLMError("pool selector expected a JSON object")
        related_ids = data.get("related_ids")
        if not (
            isinstance(related_ids, list)
            and len(related_ids) <= max_count
            and len(set(related_ids)) == len(related_ids)
            and all(isinstance(x, str) and x for x in related_ids)
            and set(related_ids) <= allowed_ids
        ):
            raise LLMError(
                f"pool selector expected at most {max_count} distinct related_ids"
            )

    return _validate


class SkillDistiller:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.model, self.variant, self.timeout = cfg.llm_settings("distiller")
        self.K = int(cfg.get("distiller.max_skills_per_patch", 3))
        self.max_chars = int(cfg.get("distiller.max_skill_chars", _MAX_SKILL_CHARS))
        self.retries = int(cfg.get("distiller.score_retries", 2))
        self.reuse_gate_min = float(cfg.get("distiller.reuse_gate_min", 0.25))
        self.correctness_gate_min = float(
            cfg.get("distiller.correctness_gate_min", 0.50)
        )

    def _flow_block(self, e: Evidence) -> str:
        names = {
            "single_success": "distiller_flow_success.md",
            "single_failure": "distiller_flow_failure.md",
            "pair": "distiller_flow_pair.md",
        }
        name = names[e.kind]
        return load_prompt(name, self.cfg)

    def _build_prompt(
        self, e: Evidence, pool: SkillPool, related_ids: list[str]
    ) -> str:
        return render_template(
            load_prompt("distiller_prompt.md", self.cfg),
            {
                "EVIDENCE_DIGEST": evidence_digest(e),
                "POOL_DIGEST": pool_digest(pool),
                "RELATED_SKILL_DETAILS": pool_details(pool, related_ids),
                "FLOW_BLOCK": self._flow_block(e),
                "MAX_SKILL_CHARS": f"{self.max_chars}",
                "MAX_DESCRIPTION_CHARS": f"{MAX_SKILL_DESCRIPTION_CHARS}",
                "MAX_OPERATIONS": f"{2 * self.K}",
            },
        )

    def _select_related_ids(
        self, e: Evidence, pool: SkillPool
    ) -> list[str] | None:
        if pool.is_empty():
            return []
        max_count = 2 * self.K
        allowed_ids = {f"skillpool://{sid}" for sid in pool.skills}
        prompt = render_template(
            load_prompt("pool_selector_prompt.md", self.cfg),
            {
                "EVIDENCE_DIGEST": evidence_digest(e),
                "POOL_DIGEST": pool_digest(pool),
                "MAX_RELATED_SKILLS": f"{max_count}",
            },
        )
        try:
            data = complete_json(
                prompt,
                self.model,
                self.timeout,
                self.variant,
                retries=self.retries,
                validate=_make_validate_pool_selection(max_count, allowed_ids),
            )
        except LLMError as ex:
            log.warning("pool selector failed for %s (%s)", e.instance.get("instance_id", "?"), ex)
            return None
        return [ref.removeprefix("skillpool://") for ref in data["related_ids"]]

    def _build_score_prompt(self, e: Evidence, pool: SkillPool, cand_block: str) -> str:
        return render_template(
            load_prompt("scorer_prompt.md", self.cfg),
            {
                "EVIDENCE_DIGEST": evidence_digest(e),
                "POOL_DIGEST": pool_digest(pool),
                "CANDIDATE_BLOCK": cand_block,
            },
        )

    def distill(self, e: Evidence, pool: SkillPool) -> list[PatchOp]:
        related_ids = self._select_related_ids(e, pool)
        if related_ids is None:
            return []
        prompt = self._build_prompt(e, pool, related_ids)
        try:
            data = complete_json(
                prompt,
                self.model,
                self.timeout,
                self.variant,
                retries=self.retries,
                validate=_make_validate_candidates(self.max_chars, 2 * self.K),
            )
        except LLMError as ex:
            log.warning(
                "distill produced NO candidates for %s (LLM call failed: %s)",
                e.instance.get("instance_id", "?"),
                ex,
            )
            return []

        raw = (
            data.get("candidates", data.get("ops", []))
            if isinstance(data, dict)
            else data
        )
        ops = [PatchOp.from_dict(item) for item in raw if isinstance(item, dict)]
        src = e.instance.get("instance_id", "")
        for op in ops:
            if src and src not in op.source_instances:
                op.source_instances.append(src)
        return self._filter_valid(ops, pool, set(related_ids))

    def score_candidates(
        self, candidates: list[PatchOp], e: Evidence, pool: SkillPool
    ) -> list[tuple[PatchOp, float]]:
        if not candidates:
            return []

        cand_block = "\n".join(
            self._format_candidate(i, op, pool) for i, op in enumerate(candidates)
        )
        prompt = self._build_score_prompt(e, pool, cand_block)
        try:
            data = complete_json(
                prompt,
                self.model,
                self.timeout,
                self.variant,
                retries=self.retries,
                validate=_make_validate_scores(len(candidates)),
            )
        except LLMError as ex:
            log.warning("score_candidates: dropping all candidates (%s)", ex)
            return [(op, 0.0) for op in candidates]

        score_map: dict[int, tuple[float, dict]] = {}
        for entry in _score_entries(data):
            if _valid_score(entry):
                score_map[entry["index"]] = _aggregate_score(
                    entry,
                    self.reuse_gate_min,
                    self.correctness_gate_min,
                )

        scored = []
        for i, op in enumerate(candidates):
            total, dims = score_map.get(i, (0.0, {}))
            op.score_dims = dims
            scored.append((op, total))
        return sorted(scored, key=lambda x: x[1], reverse=True)

    @staticmethod
    def _resolve_id(ref: str, pool: SkillPool) -> str | None:
        if not ref:
            return None
        if ref.startswith("skillpool://"):
            ref = ref.removeprefix("skillpool://")
        if ref in pool.skills:
            return ref
        for sid, sk in pool.skills.items():
            if sk.name == ref:
                return sid

        prefixed = [sid for sid in pool.skills if sid.startswith(ref + "-")]
        return prefixed[0] if len(prefixed) == 1 else None

    def _filter_valid(
        self,
        ops: list[PatchOp],
        pool: SkillPool,
        related_ids: set[str] | None = None,
    ) -> list[PatchOp]:
        kept = []
        for op in ops:
            if op.op not in _ALLOWED_OPS:
                log.debug("filter_valid: drop unknown op %r", op.op)
                continue

            if op.op in ("create", "merge") and not (
                op.content.strip() and op.description.strip()
            ):
                continue
            if op.op == "create" and not op.name.strip():
                continue
            if op.op == "revise" and not (
                op.name.strip() or op.content.strip() or op.description.strip()
            ):
                continue
            if op.name and not _valid_name(op.name):
                continue
            if op.content.strip() and (
                len(op.content) > self.max_chars or self._too_specific(op.content)
            ):
                continue
            if op.op in ("revise", "remove"):
                resolved = self._resolve_id(op.target_id or "", pool)
                if resolved is None:
                    log.debug(
                        "filter_valid: drop %s (target_id=%r not found)",
                        op.op,
                        op.target_id,
                    )
                    continue
                if related_ids is not None and resolved not in related_ids:
                    log.debug("filter_valid: drop %s (target was not selected)", op.op)
                    continue
                op.target_id = resolved
            if op.op == "merge":
                op.merge_ids = [
                    resolved
                    for ref in op.merge_ids
                    if (resolved := self._resolve_id(ref, pool))
                ]
                if len(op.merge_ids) < 2:
                    log.debug("filter_valid: drop merge (fewer than 2 ids resolved)")
                    continue
                if related_ids is not None and not set(op.merge_ids) <= related_ids:
                    log.debug("filter_valid: drop merge (source was not selected)")
                    continue
            kept.append(op)
        return kept

    @staticmethod
    def _too_specific(content: str) -> bool:
        return (
            bool(re.search(r"line\s+\d{2,}", content, re.IGNORECASE))
            or len(re.findall(r"/[\w./-]{15,}", content)) >= 3
        )

    def _format_candidate(self, i: int, op: PatchOp, pool: SkillPool) -> str:
        head = f"[{i}] {op.op.upper()}"
        if op.op == "create":
            return (
                f"{head} name={op.name!r}\n"
                f"    description: {inline_preview(op.description, max(MAX_SKILL_DESCRIPTION_CHARS, len(op.description)))}\n"
                f"    content: {inline_preview(op.content, self.max_chars)}"
            )
        if op.op == "revise":
            sk = pool.skills.get(op.target_id or "")
            baseline = ""
            if sk:
                baseline = (
                    f"    current name: {sk.name!r}\n"
                    "    current description: "
                    f"{inline_preview(sk.description, max(MAX_SKILL_DESCRIPTION_CHARS, len(sk.description)))}\n"
                    f"    current content: {inline_preview(sk.content, self.max_chars)}\n"
                )
            revised_name = repr(op.name) if op.name else "(unchanged)"
            revised_description = (
                inline_preview(
                    op.description,
                    max(MAX_SKILL_DESCRIPTION_CHARS, len(op.description)),
                )
                if op.description.strip()
                else "(unchanged)"
            )
            revised_content = (
                inline_preview(op.content, self.max_chars)
                if op.content.strip()
                else "(unchanged)"
            )
            return (
                f"{head} target_id={op.target_id}\n"
                f"{baseline}"
                f"    revised name: {revised_name}\n"
                f"    revised description: {revised_description}\n"
                f"    revised content: {revised_content}"
            )
        if op.op == "merge":
            merged = []
            for sid in op.merge_ids:
                sk = pool.skills.get(sid)
                if sk:
                    merged.append(
                        f"        - id={sid} name={sk.name!r}\n"
                        f"          description: {inline_preview(sk.description, max(MAX_SKILL_DESCRIPTION_CHARS, len(sk.description)), pad='          ')}\n"
                        f"          content: {inline_preview(sk.content, self.max_chars, pad='          ')}"
                    )
                else:
                    merged.append(f"        - id={sid}")
            merged_block = "\n".join(merged)
            return (
                f"{head} {op.merge_ids} -> {op.name!r}\n"
                f"    current skills:\n{merged_block}\n"
                f"    merged description: {inline_preview(op.description, max(MAX_SKILL_DESCRIPTION_CHARS, len(op.description)))}\n"
                f"    merged content: {inline_preview(op.content, self.max_chars)}"
            )
        if op.op == "remove":
            sk = pool.skills.get(op.target_id or "")
            if sk:
                return (
                    f"{head} id={op.target_id} name={sk.name!r}\n"
                    "    current description: "
                    f"{inline_preview(sk.description, max(MAX_SKILL_DESCRIPTION_CHARS, len(sk.description)))}\n"
                    f"    current content: {inline_preview(sk.content, self.max_chars)}"
                )
            return f"{head} id={op.target_id}"
        return f"[{i}] UNKNOWN op={op.op}"
