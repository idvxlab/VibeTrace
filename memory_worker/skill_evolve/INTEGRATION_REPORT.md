# Skill Evolve（在线沉淀）接入报告

日期：2026-07-28

## 结论

已将 `vibetrace-skill` 中 **与 SWE-bench 无关的在线沉淀核心** 迁入 `memory_worker/skill_evolve/`，并替换默认的 analyzer → writer 流程。

**保留不变：**

- 任务切换判定（task switch judge）
- 切换后抽取 `trace.session.v1`
- 写入 `task-skill-index` / skill history，前端 Skill Panel 轮询 `/task-skills`

**已替换：**

- `run_analyzer` + `run_writer` → `skill_evolve` 的  
  **Evidence → Estimator 门控 → Distiller 候选 → Scorer 打分 → Patch 落盘**

回退旧流程：设置环境变量 `MW_SKILL_PIPELINE=legacy`。

---

## 代码落位

```text
memory_worker/skill_evolve/
  __init__.py
  config.py              # 纯 stdlib 配置（无 PyYAML / 无 SWE-bench）
  llm.py                 # 支持 memory_worker HTTP complete provider
  estimator.py / distiller.py / skillpool.py / evidence.py / trace.py
  prompt_context.py / prompt_format.py / prompt_loader.py
  online_adapter.py      # trace.session.v1 → Evidence；磁盘 SkillPool 读写
  online_pipeline.py     # 单次在线沉淀入口
  prompts/               # estimator / distiller / scorer / pool_selector
```

**刻意未迁入（SWE-bench / 实验基础设施）：**

- `dataset.py` / `evaluate.py` / `evaluator.py` / `crun_backend.py`
- `opencode_runner.py` / `parallel.py` / `budget.py` / `objective.py`
- `distill_loop.py` / `cli.py` / `feedback.py`（实验 fork 循环）
- `data/`、`scripts/`、`config/default.yaml` 中的 dataset/evaluator 段

顶层 `vibetrace-skill/` 与 `vibetrace-skill.zip` 可在你确认新链路稳定后删除；运行时 **不再依赖** 该目录。

---

## 数据接入契约

### 输入（已对齐现有 memory_worker）

任务切换后仍调用：

```text
trace_parser.build_session_trace_bundle(...) → schemaVersion: "trace.session.v1"
```

可选 `fork`（fork 对比）时，adapter 会建成 `Evidence.kind = "pair"`；否则按 finish/error 建成 `single_success` / `single_failure`。

### 中间过程

| 步骤 | 日志文件（runDir 内） | 含义 |
|------|----------------------|------|
| start | `00-run.log` 事件 `skill_evolve.*` | 引擎接入标记 |
| pool | `02b-skill-evolve-pool.json` | 从磁盘 roots 加载的 SkillPool |
| evidence | `03-skill-evolve-evidence.json` | 转换后的 Evidence |
| estimator | `04-skill-evolve-estimator.json` | 是否通过门控 |
| candidates | `05-skill-evolve-candidates.json` | PatchOp 候选 |
| scores | `05c-skill-evolve-scores.json` | 打分与阈值 |
| applied | `06-skill-evolve-applied.json` | 实际写入/删除 |
| 兼容前端 | `05-skill-suggestions.json` / `07-writer-result.json` | 与旧索引逻辑兼容 |

如何确认接入了 skill_evolve：打开对应 `memory_worker/logs/<runId>/`，应看到：

1. `00-summary.json` 里 `"engine": "skill_evolve"`
2. `00-run.log` 含 `skill_evolve.start` / `skill_evolve.done`
3. `/health` 返回 `"skillPipeline": "skill_evolve"`

### 输出 → 前端 Skill Panel

PatchOp 映射：

| PatchOp | 前端 operation | 磁盘行为 |
|---------|----------------|----------|
| create / merge | CREATE | 在 `SKILL_WRITE_ROOT` 写新 `SKILL.md` |
| revise | UPDATE | 更新已有 skill 目录 |
| remove | DELETE | 删除 skill 目录 |

`register_task_skill_result` 仍消费 `writerResults[]`，因此 Skill Panel 的列表 / 详情 / history **无需改 API**。history 的 `source` 在 evolve 路径下为 `skill_evolve`。

---

## LLM 调用方式

`skill_evolve` 默认通过 memory_worker 已有的 **OpenCode HTTP**（`opencode_generate_text`）调用，日志落在同一 runDir（`03a-estimator-*`、`05a-distiller-*`、`05b-scorer-*`）。

模型默认：`MW_SKILL_EVOLVE_MODEL` 或 `OPENCODE_MODEL`，否则 `relay/deepseek-v4-flash`。

---

## 预期运行结果

触发一次任务切换并完成抽取后，预期：

1. **Estimator 未过门控**（常见）：不写 skill；`07-writer-result.json` 为 skipped；面板无新 skill。日志：`skill_evolve.skip reason=estimator_gate_failed`。
2. **过门控但候选被 scorer 拒绝**：同样不落盘；日志：`no_candidates_above_threshold`。
3. **有 accepted patches**：在 `~/.claude/skills`（或 `SKILL_WRITE_ROOT`）创建/更新/删除；`task-skill-index.json` 更新；前端 Skill Panel 出现对应 CREATE/UPDATE/DELETE 记录。

与旧 analyzer/writer 的体验差异：

- 旧链路：偏「写指导文档式」SKILL.md（sections + file_guidance）
- 新链路：偏「可复用 capability skill」+ Skip when 约束，并带 reuse/correctness/效率门控，**更少但更严**

---

## 配置开关

| 变量 | 默认 | 作用 |
|------|------|------|
| `MW_SKILL_PIPELINE` | `skill_evolve` | `legacy` 可回退 analyzer+writer |
| `MW_SKILL_EVOLVE_MODEL` | （见上） | evolve LLM 模型名 |
| `SKILL_WRITE_ROOT` | `~/.claude/skills` | 落盘根目录 |

---

## 本地冒烟（已跑通）

用历史 `01-trace.json` 做转换 + mock LLM：

- import / evidence 转换成功
- pipeline 写出 `skill_evolve.*` 日志文件
- `server.py` AST 解析通过

完整端到端仍依赖本机 OpenCode HTTP 可用。
