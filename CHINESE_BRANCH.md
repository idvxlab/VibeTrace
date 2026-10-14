# chinese 分支说明

相对 `origin/dev`，`chinese` 目前只多 **1 个已提交 commit**，外加一批 **未提交** 的用户实验埋点改动。

基线：`origin/dev`  
分支 tip：`cbb5988 fix:对话过程修复`（2026-07-28）

---

## 1. 已提交：相对 `dev` 改了什么

一句话：**把英文面向论文/demo 的那套，收成中文用户实验可用的对话链路**，并修了对话过程相关问题。

### 1.1 中文化（相对 `dev` 上的 English UI）

| 区域 | 变化 |
|------|------|
| `src/config/harnessGuidance.ts` | harness 前缀、`用户输入` 标记、注释改回中文；发送策略文案中文化 |
| `memory_worker/prompts/*.md` | analyzer / error_diagnosis / feedback_distill / task_switch / writer 等 prompt 改回中文 |
| `memory_worker/server.py`、`trace_parser.py` | 与中文 prompt / 文案配套的字符串与逻辑调整 |
| 前端若干组件 | `MessageBubble` / `MessageInput` / `MessagePanel` / `App` / `ActionFlowVisualization` 等对话链路文案与行为对齐中文场景 |

### 1.2 去掉论文 case-study 的「tooltip 英译」管线

删除（不再需要把中文 tooltip 翻成英文做 paper session）：

- `src/utils/tooltipTranslate.ts`
- `src/hooks/useTooltipTranslate.ts`
- `src/config/tooltipTranslateSessions.ts`

相关调用从 `SubtaskCard` / `SubtaskDebugPanel` / `actionTooltipMapping` 等处撤掉。

### 1.3 对话过程修复

`App` / `MessageInput` / `taskSegmentStorage` / `memoryWorkerSessions` 等有小幅修复，保证中文 harness + 任务切换在真实对话里更稳（commit 信息：`fix:对话过程修复`）。

---

## 2. 未提交（工作区里已有，但还没进 git）

这些是当前 `chinese` 上正在做的 **用户实验埋点**，**push 之前不会出现在远程**：

| 路径 | 作用 |
|------|------|
| `src/experiment/` | 实验 Start/End UI、计数器、事件、报告类型与说明 |
| `memory_worker/server.py` | `POST /experiment-report` 写盘 |
| `src/services/memoryWorkerApi.ts` | 前端调用写报告 |
| `src/App.tsx` 等组件挂钩 | 滚动、点击、fork、distill、焦点时间等埋点 |
| `vite.config.ts` | 代理 `/experiment-report` |
| `memory_worker/prompts/task_switch_prompt.md` | task-switch 文案微调 |

另外本地还有未跟踪的 `vibetrace-skill/` 与 `vibetrace-skill.zip`（技能蒸馏/评测子项目），**一般不要推进可视化远程仓**。

详情见：`src/experiment/README.md`。

---

## 3. 和 `main` / 产品能力的关系（背景）

`chinese` 继承了 `dev` 上已有的产品能力（不是 chinese 独有），包括但不限于：

- memory-worker：trace 解析、task-switch、error diagnosis、feedback distill
- 子任务拆分面板、skill 详情/编辑、fork 继承 task-switch 状态
- case-study demo overlay（`src/caseStudy/`，本地 override 仍被 `.gitignore`）

`chinese` 相对 `dev` 的差异，主要是 **语言面 + 去掉英译 tooltip + 对话修复**；实验埋点仍是 WIP。

---

## 4. 推到个人远程时注意

- `logs/`、`memory_worker/logs/`、`node_modules/`、`dist/`、`.env.local` 等已在 `.gitignore`，**本来就不会进 push**。
- 仓库里目前没有跟踪的顶层 `docs/`；若你指 README 等文档，需要另做 sparse/过滤再推。
- **未 commit 的实验埋点不会被推上去**；要带上就先 commit 再 push。
- 强制覆盖对方分支用 `--force`（见聊天里给的命令）。
