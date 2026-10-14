# VibeTrace 用户实验埋点说明

本地用户实验用的交互计数与导出流程。数据写在**用户当前工作区文件夹根目录**，不写进本仓库。

---

## 1. 自动录制流程（Always-on）

1. 左侧选好任务文件夹 → **自动开始录制**（无需点 Start）。
2. 最左侧文件夹栏底部可改被试号（默认 `P01`）；红点亮起表示正在录。
3. 同一文件夹内可开多个 session，都记在该文件夹的实验里。
4. 换到另一个任务文件夹 → **自动**为新文件夹开一份桶；事件只进当前文件夹。
5. 正常做任务即可。系统会在每个操作过的工作区下自动创建子文件夹并写入行为数据（约 8s 防抖 / 30s 周期 / 切走或关页时也会写）：

   ```text
   {workspace}/vibetrace-behavior/vibetrace-experiment-P01-<experimentId>.json
   ```

6. 滑走标签页、切应用、关页、刷新 → **不会停录**；回到页面继续录，并从 `localStorage` 恢复。
7. 同一实验覆盖写同一文件，不刷屏。
8. 让被试把每个任务文件夹里的 **`vibetrace-behavior/` 整个文件夹** 发回即可汇总。需要立刻落盘时可点底部 **Save**。

**注意：**

- **不需要 Start / End**；选中文件夹即录，离开页面也不停。
- 每个操作过的 workspace **各自一份** JSON，写在 `{workspace}/vibetrace-behavior/`。
- 切换 workspace **不会**丢掉另一边的数据，只是暂停往那边写事件。
- 刷新页面不会丢进行中的实验（`localStorage` 多文件夹草稿）。
- 自动落盘失败会进 pending，下次打开 / 回前台再重试；手动 Save 失败才会下载兜底。
- 改过 worker 后需重启 `npm run worker:py`；Vite 代理了 `/experiment-report`。

---

## 2. 架构（怎么落盘）

```text
前端 experimentTelemetry.track(...)
  → 按当前选中 directory 路由到对应草稿
  → 内存 + localStorage（多文件夹并存）
  → 防抖 / 定时 / pagehide：snapshot（不 End）
  → POST memory-worker /experiment-report（稳定 filename 覆盖写）
  → 写入 {workspaceDirectory}/vibetrace-behavior/vibetrace-experiment-{pid}-{experimentId}.json
```

| 模块 | 路径 |
|------|------|
| 类型与计数器定义 | `src/experiment/types.ts` |
| 埋点单例（按文件夹分桶） | `src/experiment/telemetry.ts` |
| Always-on 状态栏 | `src/experiment/ExperimentBar.tsx`（最左侧文件夹栏底部） |
| 自动落盘 / pending 重试 | `src/experiment/persistReport.ts` |
| Mock 样例 | `src/experiment/mockReport.example.json` |
| Worker 写盘 | `memory_worker/server.py` → `save_experiment_report` / `POST /experiment-report` |
| 前端 API | `src/services/memoryWorkerApi.ts` → `saveExperimentReport` |
| Vite 代理 | `vite.config.ts` → `/experiment-report` |
| 草稿 key | `STORAGE_KEYS.experimentActive`（多文件夹 v2） |
| 关页失败兜底 | `STORAGE_KEYS.experimentPendingReports` |

内部 OpenCode 会话（标题含 `[mw-internal]`）**不计入**手动 session。

---

## 3. 计数器字段（`counters`）

| 字段 | 含义 | 统计方式 |
|------|------|----------|
| `manualSessionsCreated` | 手动新建 session 次数 | 侧栏 New Session 成功；不含 mw-internal |
| `conversationTurns` | 对话轮次 | 用户每发出一条消息 +1（含 fork 后首条） |
| `chatPanelScrolls` | 中间对话区滚动次数 | `scroll` 去抖 400ms，一次拖动算 1 次 |
| `trajectoryPanelScrolls` | 右侧轨迹列表滚动次数 | 同上 |
| `trajectoryPanelClicks` | 右侧面板操作次数 | 点子任务卡、切 task tab、切 timeline/summary 等 |
| `todoClicks` | Todo 面板内点击总次数 | 点标题展开、分区折叠、任意 todo 行，**面板内任何可点内容** |
| `actionTooltipShows` | Action tooltip 真正亮起次数 | `react-tooltip` 的 `afterShow`（timeline 节点 + summary 色块） |
| `flowEndSummaryTooltipShows` | 轨迹末端黄色 Summary 节点 tooltip | 悬浮 flow-end 节点且真正弹出 |
| `trajectoriesViewed` | **查看过**几个 panel（去重） | 选中 / 滚入视野 / **鼠标扫过 tooltip 锚点**，按 subtask id **去重**（不必等 tooltip 弹出） |
| `taskTabsSeen` | 出现过几个 Task tab | 实验期间 task tab id **去重** |
| `skillsDistilled` | 沉淀 skill 次数 | Distill **成功**回包后 +1 |
| `forksCompleted` | Fork 次数 | fork API 成功后 +1 |
| `skillPanelClicks` | Skill Panel 点击次数 | 打开某个 skill 详情 |
| `subtaskPanelsGenerated` | **生成了**多少 panel / trace | 实验期间观察到的 subtask id **去重** |
| `chatPanelFocusMs` | 鼠标在中间对话/composer 区停留毫秒（不含 Todo） | `pointerenter` / `pointerleave` |
| `todoPanelFocusMs` | Todo 面板停留毫秒 | 同上（离开后 resume chat） |
| `sessionPanelFocusMs` | 左侧 session 列表停留毫秒 | 同上 |
| `taskBarFocusMs` | 右侧 Task tab 栏停留毫秒 | 同上（离开后 resume trajectory） |
| `trajectoryPanelFocusMs` | 右侧轨迹区停留毫秒（含 Action type legend） | 同上 |
| `skillPanelFocusMs` | Skill Panel 停留毫秒 | 同上（离开后 resume trajectory） |
| `tooltipPanelFocusMs` | Action / flow-end tooltip 打开期间毫秒 | tooltip open/close |

### 派生字段（`derived`）

由 counters 自动计算，便于直接写进实验分析：

| 字段 | 含义 |
|------|------|
| `chatFocusRatio` 等 | 各面板焦点 / **全部焦点面板合计**（见 `panelFocusShares`） |
| `panelFocusShares` | `{chat,todo,session,task,trajectory,skill,tooltip}` 占比 |
| `trajectoryFocusRatio` | 右侧轨迹区焦点时间占比 |
| `chatScrollShare` | 中间滚动次数 / 总滚动次数 |
| `trajectoryInteractionShare` | 右侧相关操作 / (左侧操作+右侧操作) 的粗占比 |
| `firstInteractionOrder` | 各区域按「首次交互」时间排序（未碰过的区域不出现） |
| `firstInteractionMs` | 各区域首次交互相对 `startedAt` 的毫秒；未碰为 `null` |
| `panelViewCoverage` | `trajectoriesViewed / subtaskPanelsGenerated`（看了几个 / 生成了几个） |

焦点/滚动拿不到「绝对真实注意力」，只是可复现的代理指标；论文里建议写明定义。

**Panel 覆盖率**：对比 `subtaskPanelsGenerated`（生成数）与 `trajectoriesViewed`（查看数，去重）。也可直接看 `derived.panelViewCoverage`。

### 对话时间线 / Agent 工作时间（主指标）

| 字段 | 含义 |
|------|------|
| `firstUserTurnAt` / `firstUserTurnMs` | **第一个对话输入**时间 |
| `lastConversationEndAt` | **最后一个对话结束**（末次 `agent.turn_end`） |
| `conversationSpanMs` | 首输 → 末次对话结束（含用户思考间隔） |
| **`agentWorkMs`** | **真正的 agent 工作时间**：每次「发送→助手回复完成/中止」累加（主指标） |
| `agentWorkShareOfConversation` | agentWorkMs / conversationSpanMs |
| `systemFocusMs` | 各面板指针停留合计（UI 使用，不是 agent 工作） |
| `solveEndAt` / `solveDurationMs` | 次要：轨迹 `subtask.generated` 窗口 |
| `focusDuringSolveMs` 等 | 对话窗口（优先 conversation span）内的面板焦点阶段 |

事件：`agent.turn_start` / `agent.turn_end`（`props.ms` = 本轮工作毫秒）。

### 首次交互（`firstInteractionAt`）

每个区域只记**第一次**点击 / 滚动 / 发消息的 ISO 时间；未使用则为 `null`。用来还原「先摸哪块 UI」的顺序（也可用 `derived.firstInteractionOrder`）。

| 区域 | 触发（任一即可，只取最早） |
|------|---------------------------|
| `chat` | 对话区滚动、发送消息 |
| `trajectory` | 右侧轨迹滚动 / 点击 / 看子任务 / tooltip / 切 task tab |
| `todo` | Todo 面板内任意点击（标题 / 分区 / todo 行） |
| `skill` | Skill Panel 打开详情、或 Distill 成功 |

事件日志里会多一条 `region.first`（`props.region` + `props.via`），之后同区域不再记。

---

## 4. 事件明细（`events[]`）

每条大致为：

```json
{
  "ts": "2026-07-28T02:15:22.440Z",
  "event": "todo.click",
  "sessionId": "ses_...",
  "directory": "/path/to/workspace",
  "props": { "todoId": "..." }
}
```

常见 `event` 名：

- `experiment.start` / `experiment.end`
- `session.create`
- `chat.turn` / `chat.scroll`
- `trajectory.scroll` / `trajectory.click` / `trajectory.view`
- `todo.panel_click`
- `panel.view`（某 panel 首次被查看，含 `via`：select / scroll / tooltip.* / card）
- `tooltip.action` / `tooltip.flow_end_summary`
- `task_tab.seen` / `task_tab.select`
- `skill.distill` / `skill.panel_click`
- `fork.complete`
- `subtask.generated`
- `panel.focus`
- `region.first`（某区域首次交互，仅一次）

事件日志有上限（约 2000 条），超出丢最旧的；汇总分析优先看 `counters` + `firstInteractionAt` + `derived`。

---

## 5. 报告顶层字段

| 字段 | 说明 |
|------|------|
| `schemaVersion` | 固定 `experiment.report.v1` |
| `participantId` | 被试号 |
| `experimentId` | 本次实验唯一 id |
| `directory` | 写入时的工作区路径 |
| `startedAt` / `endedAt` | ISO 时间（`endedAt` = 最近 checkpoint） |
| `durationMs` | 自开始至最近 checkpoint |
| `sessionIds` | 实验期间碰到过的 session id 列表 |
| `counters` / `firstInteractionAt` / `derived` / `events` | 见上 |
| `notes` | 自动落盘时为 `live` |

完整 Mock 见：`src/experiment/mockReport.example.json`。

---

## 6. 挂钩位置（改代码时查这里）

| 行为 | 大致挂钩点 |
|------|------------|
| Always-on 状态栏 | `src/experiment/ExperimentBar.tsx`，挂在最左侧文件夹栏底部 |
| 新建 session | `App.tsx` → `handleCreateSession` |
| 发消息 / 对话轮 | `App.tsx` → `handleSendMessage`（及 fork 后首条） |
| Todo 点击 | `App.tsx` → `handleTodoClick` |
| 子任务卡 / 轨迹查看 | `App.tsx` → `toggleSubtaskLink` |
| Task tab | `App.tsx` → `handleSelectTaskSegment` + tabs 出现时 `onTaskTabSeen` |
| 子面板生成 | `App.tsx` → `assistantSubtasks` 变化时 `onSubtasksObserved` |
| Fork | `App.tsx` → fork 成功后 `onForkComplete` |
| 中间滚动 | `MessagePanel.tsx` → message list `onScroll` |
| 右侧滚动 | `SubtaskDebugPanel.tsx` → list `onScroll` |
| Action / flow-end tooltip | `ActionFlowVisualization.tsx` → Tooltip `afterShow` |
| Summary 色块 tooltip | `SubtaskDebugPanel.tsx` → summary Tooltip `afterShow` |
| Skill 打开 / Distill | `SubtaskDebugPanel.tsx` → `openSkillDetail` / distill `.then` |
| 左右焦点时间 | `App.tsx` → 中间栏 / 右栏 `onPointerEnter` / `Leave` |

---

## 7. 给被试的一句话指引

> 选好任务文件夹就会自动录（红点亮）→ 换文件夹自动分开记并各自落盘 → 中间滑走/关页/刷新都不会停 → 做完把各任务目录里的 `vibetrace-behavior/` 文件夹发给我们。

---

## 8. 已知边界

- Tooltip 按「真正弹出」计，不是每次 mouseenter。
- 滚动按去抖后的「滚动爆发」计，不是原生 scroll 事件次数。
- 「对话轮次」≈ 用户发送次数，不是严格的 user+assistant 配对完成数。
- 焦点时间依赖鼠标进出面板，切换窗口/看别处但鼠标还在面板上时会偏高。
- `firstInteractionAt` 不计纯悬停（`panel.focus`），只计点击 / 滚动 / 发消息；鼠标滑过不算「首次交互」。
- 不默认记录 prompt / 代码全文，只记 id 与计数（隐私友好）。
- 报告里的 `endedAt` 在 always-on 下表示**最近一次 checkpoint 时间**，不是正式结束。
- 清浏览器站点数据会丢掉尚未写到文件夹的草稿；磁盘上的 JSON 不受影响。
