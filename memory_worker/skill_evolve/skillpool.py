from __future__ import annotations

import json
import re
import shutil
import uuid
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Literal

OpKind = Literal["create", "revise", "merge", "remove"]
MAX_SKILL_NAME_CHARS = 64
MAX_SKILL_DESCRIPTION_CHARS = 200


@dataclass
class Skill:
    id: str
    name: str
    content: str
    description: str = ""
    source_instances: list[str] = field(default_factory=list)
    created_round: int = 0
    revised_round: int = 0
    kind: str = "capability"

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class PatchOp:
    op: OpKind
    name: str = ""
    content: str = ""
    description: str = ""
    target_id: str | None = None
    merge_ids: list[str] = field(default_factory=list)
    source_instances: list[str] = field(default_factory=list)
    kind: str = "capability"

    @classmethod
    def from_dict(cls, d: dict) -> "PatchOp":
        return cls(
            op=d.get("op") or "create",
            name=d.get("name") or "",
            content=d.get("content") or "",
            description=d.get("description") or "",
            target_id=d.get("target_id"),
            merge_ids=d.get("merge_ids") or [],
            source_instances=d.get("source_instances") or [],
            kind=d.get("kind") or "capability",
        )


@dataclass
class Patch:
    ops: list[PatchOp] = field(default_factory=list)


class SkillPool:
    def __init__(self, skills: dict[str, Skill] | None = None):
        self.skills: dict[str, Skill] = skills or {}

    def __len__(self) -> int:
        return len(self.skills)

    def is_empty(self) -> bool:
        return len(self.skills) == 0

    def list(self) -> list[Skill]:
        return list(self.skills.values())

    def apply(self, patch: Patch, round_idx: int = 0) -> list[str]:
        applied: list[str] = []
        for op in patch.ops:
            try:
                applied.append(self._apply_op(op, round_idx))
            except Exception as e:
                applied.append(f"[skip] {op.op} failed: {e}")
        return applied

    def _apply_op(self, op: PatchOp, round_idx: int) -> str:
        if op.op == "create":
            sid = new_id(op.name)
            self.skills[sid] = Skill(
                id=sid,
                name=op.name,
                content=op.content.strip(),
                description=op.description.strip(),
                source_instances=op.source_instances,
                created_round=round_idx,
                revised_round=round_idx,
                kind=op.kind,
            )
            return f"[create] {sid} ({op.name})"

        if op.op == "revise":
            if op.target_id not in self.skills:
                raise KeyError(f"revise target not found: {op.target_id}")
            sk = self.skills[op.target_id]
            if op.content.strip():
                sk.content = op.content.strip()
            if op.description.strip():
                sk.description = op.description.strip()
            if op.name:
                sk.name = op.name
            sk.source_instances = sorted(
                set(sk.source_instances) | set(op.source_instances)
            )
            sk.revised_round = round_idx
            return f"[revise] {op.target_id}"

        if op.op == "remove":
            if op.target_id not in self.skills:
                raise KeyError(f"remove target not found: {op.target_id}")
            self.skills.pop(op.target_id)
            return f"[remove] {op.target_id}"

        if op.op == "merge":
            ids = [i for i in op.merge_ids if i in self.skills]
            if len(ids) < 2:
                raise ValueError(f"merge needs >=2 existing skills, got {ids}")
            merged_src: set[str] = set(op.source_instances)
            for i in ids:
                merged_src |= set(self.skills[i].source_instances)
            for i in ids:
                self.skills.pop(i)
            sid = new_id(op.name or "merged")
            self.skills[sid] = Skill(
                id=sid,
                name=op.name or "merged-skill",
                content=op.content.strip(),
                description=op.description.strip(),
                source_instances=sorted(merged_src),
                created_round=round_idx,
                revised_round=round_idx,
            )
            return f"[merge] {ids} -> {sid}"

        raise ValueError(f"unknown op: {op.op}")

    SKILLS_SUBDIR = Path(".opencode") / "skills"

    def render_skill_md(self, sk: Skill, materialized_name: str | None = None) -> str:
        name = skill_slug(materialized_name or sk.name or sk.id)
        desc = one_line(sk.description) or fallback_description(sk)
        body = sk.content.strip() or f"# {sk.name}\n\n(no content)"
        yaml_desc = json.dumps(desc, ensure_ascii=False)
        return f"---\nname: {name}\ndescription: {yaml_desc}\n---\n\n{body}\n"

    def materialize_skills(self, workspace: str | Path) -> Path:
        root = Path(workspace) / self.SKILLS_SUBDIR
        if root.exists():
            shutil.rmtree(root)
        if self.is_empty():
            return root
        used: set[str] = set()
        for sk in self.skills.values():
            slug = unique_slug(skill_slug(sk.name or sk.id), used)
            used.add(slug)
            d = root / slug
            d.mkdir(parents=True, exist_ok=True)
            (d / "SKILL.md").write_text(
                self.render_skill_md(sk, materialized_name=slug), encoding="utf-8"
            )
        return root

    def export_md(self, directory: str | Path) -> Path:
        d = Path(directory)
        d.mkdir(parents=True, exist_ok=True)
        used: set[str] = set()
        for sk in self.skills.values():
            slug = unique_slug(skill_slug(sk.name or sk.id), used)
            used.add(slug)
            (d / f"{slug}.md").write_text(
                self.render_skill_md(sk, materialized_name=slug), encoding="utf-8"
            )
        return d

    def to_dict(self) -> dict:
        return {"skills": [s.to_dict() for s in self.skills.values()]}

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
        )

    @classmethod
    def from_dict(cls, d: dict) -> "SkillPool":
        skills = {}
        allowed = {f.name for f in fields(Skill)}
        for sd in d.get("skills", []):
            payload = {k: v for k, v in dict(sd).items() if k in allowed}
            skills[payload["id"]] = Skill(**payload)
        return cls(skills)

    @classmethod
    def load(cls, path: str | Path) -> "SkillPool":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))


def skill_slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "skill").lower()).strip("-")
    s = re.sub(r"-{2,}", "-", s)
    return (s[:MAX_SKILL_NAME_CHARS].strip("-")) or "skill"


def unique_slug(slug: str, used: set[str]) -> str:
    if slug not in used:
        return slug
    i = 2
    while f"{slug}-{i}" in used:
        i += 1
    return f"{slug}-{i}"


def one_line(text: str) -> str:
    return " ".join((text or "").split())


def fallback_description(sk: Skill) -> str:
    return (
        one_line(f"Use this skill when the task involves '{sk.name}'.")
        or "A reusable skill."
    )


def new_id(name: str) -> str:
    slug = skill_slug(name)[:24].strip("-") or "skill"
    return f"{slug}-{uuid.uuid4().hex[:6]}"
