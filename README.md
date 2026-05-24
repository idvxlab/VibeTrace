# VibeTrace: See how your agents think

**Visualizing Agent Runtime Behavior for Human Intervention in Vibe Coding**

面向 **[OpenCode](https://opencode.ai/)** 的 Web 仪表盘：实时查看 Agent 消息流、Todo、子任务与 Action Flow，并支持在运行时介入。

<p align="center">
<img src="./fig/timeline-view.png" alt="VibeTrace action-flow view" width="100%" />
</p>

---

## 功能概览

- **Action Flow 可视化** — 工具/Agent 步骤、分支、Tooltip，与 Todo、消息联动
- **多目录 Session** — 对齐 OpenCode 的 `x-opencode-directory`
- **实时 Harness** — SSE 推送、Todo 回放、Question 批准/拒绝
- **Session 操作** — 重命名、Fork、发送消息等

---

## 快速开始（推荐：OpenCode Plugin）

> **你不需要**再手动开三个终端跑 `opencode serve`、`npm run dev`、`npm run worker:py`。  
> **第一次**：完成下面的一次性配置。之后**只要启动 OpenCode**，plugin 会自动：启动前端（`:5173`）、启动 memory-worker（`:8714`）、写入代理配置、**打开浏览器**。

---

### 第一步：克隆仓库，安装依赖

```bash
git clone https://github.com/your-org/cockpit-ui.git
cd cockpit-ui
npm install
```

确认本机有 **Python 3**（memory-worker 用；Windows 一般为 `python`，macOS/Linux 为 `python3`）。

---

### 第二步：配置 OpenCode Plugin（一次性）

OpenCode 通过全局 **`opencode.json`** 加载 plugin。配置文件位置：

| 系统 | 全局配置文件路径 |
|------|----------------|
| **Windows** | `%APPDATA%\opencode\opencode.json` |
| **macOS / Linux** | `~/.config/opencode/opencode.json` |

若文件不存在，自行新建即可。在文件里加入 `plugin` 字段，指向本仓库里的 plugin 文件（**改成你本机的绝对路径**）：

**Windows 示例：**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "D:/projects/cockpit-ui/plugins/agent-cockpit.ts"
  ]
}
```

**macOS 示例：**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "/Users/you/projects/cockpit-ui/plugins/agent-cockpit.ts"
  ]
}
```

> **小提示**：本仓库根目录已有 `opencode.json`，其 `plugin` 字段用的是相对路径 `plugins/agent-cockpit.ts`。在 `cockpit-ui` 目录下直接运行 `opencode` CLI 时，这份项目级配置会自动生效，无需修改全局 config。  
> 若要在 **其他项目** 里也能访问 VibeTrace，则需将绝对路径写入全局 config。

配置完成后，**完全退出并重启 OpenCode**。成功时日志中会出现：

```
[VibeTrace] OpenCode API → http://127.0.0.1:xxxx
[VibeTrace] memory-worker ready
[VibeTrace] ready → http://127.0.0.1:5173
[VibeTrace] opening → http://127.0.0.1:5173
```

浏览器会自动打开 VibeTrace；若没有，请访问 http://127.0.0.1:5173

---

### 第三步：部署 OpenCode Tools（可选）

`tools/skill_router.ts` 是一个自定义工具，让 OpenCode 在回答时能检索并引用已沉淀的 Skill。

**在本仓库目录下**使用 OpenCode 时，它已由 `opencode.json` 自动加载，无需操作。

**若要在其他项目/全局使用**，把 `tools/skill_router.ts` 复制到 OpenCode 的全局 tools 目录：

| 系统 | 全局 tools 目录 |
|------|----------------|
| **Windows** | `%APPDATA%\opencode\tools\` |
| **macOS / Linux** | `~/.config/opencode/tools\` |

复制命令示例：

```bash
# macOS
cp tools/skill_router.ts ~/.config/opencode/tools/skill_router.ts

# Windows PowerShell
Copy-Item tools\skill_router.ts "$env:APPDATA\opencode\tools\skill_router.ts"
```

---

### 第四步：配置环境变量（可选）

项目**只使用两个环境文件**：

| 文件 | 用途 |
|------|------|
| [`.env.example`](./.env.example) | 字段说明模板，已提交 Git |
| `.env.local` | 个人配置，已 gitignore |

首次使用：

```bash
cp .env.example .env.local   # Windows: copy .env.example .env.local
```

Plugin 启动时会**自动维护** `.env.local` 里的 OpenCode 代理地址，**大多数用户无需手动修改**。

#### `.env.example` 字段速查

| 变量 | 含义 | 默认值 |
|------|------|--------|
| `VIBETRACE_OPENCODE_MODE` | 启动模式：`manual`（手动起 serve）或 `plugin`（桌面端自动写入） | `manual` |
| `VITE_OPENCODE_BASE` | 前端直连 OpenCode 的 URL；留空则走 Vite 同源代理（推荐） | 空 |
| `OPENCODE_PROXY_TARGET` | Vite 把 `/session`、`/global` 等转发到此地址；桌面端由 plugin 自动改写 | `http://127.0.0.1:4096` |
| `OPENCODE_BASE` | memory-worker 调 OpenCode 的地址，与上一项保持一致 | `http://127.0.0.1:4096` |
| `VITE_OPENCODE_SERVER_PASSWORD` | 桌面端或带密码的 serve 需要；plugin 会自动写入，无需手填 | 空 |
| `VITE_OPENCODE_SERVER_USERNAME` | Basic 鉴权用户名，通常固定 `opencode` | `opencode` |
| `VITE_OPENCODE_DEFAULT_MODEL` | 发消息时的默认模型，格式 `provider_id/model_id` | 空 |
| `VITE_OPENCODE_DIRECTORY_SEEDS` | 工作区目录种子，逗号分隔的绝对路径 | 空 |
| `VITE_MEMORY_WORKER_BASE` | 前端访问 memory-worker 的 URL；留空走 Vite 代理 | 空 |
| `VITE_TRACE_SESSION_TURN_LIMIT` | ingest 时打包的 session 轮次数 | `5` |
| `MEMORY_WORKER_PORT` | memory-worker 监听端口 | `8714` |
| `OPENCODE_DIRECTORY` | 限定 memory-worker 读取的 OpenCode 工作目录 | 空（项目根） |
| `SKILL_WRITE_ROOT` | memory-worker **生成/更新 Skill 文件**的根目录（见下文） | `~/.claude/skills` |
| `MW_ANALYZER_MODE` | trace 分析方式：`opencode`（走 OpenCode）或 `mock`（本地假数据） | `opencode` |
| `MW_WRITER_MODE` | Skill 写入方式：`opencode` 或 `template`（本地模板兜底） | `opencode` |
| `MW_SESSION_STRATEGY` | 调用 OpenCode 时的会话策略：`new`（新建）或 `fork` | `new` |
| `MW_SESSION_TITLE_PREFIX` | memory-worker 创建的会话标题前缀；前端据此跳过 skill 沉淀展示 | `[mw-internal]` |
| `VIBETRACE_NO_BROWSER` | 设为 `1` 时 plugin 不自动打开浏览器 | 空 |
| `PYTHON` | 启动 memory-worker 用的 Python 可执行文件 | Windows: `python`，Unix: `python3` |
| `VITE_DEBUG_VERBOSE_LOGS` | 设为 `1` 时前端输出详细调试日志 | 空 |

---

### Skill 从哪里读取？写到哪里？

**读取（OpenCode 加载 Skill）**

OpenCode 从以下两个位置加载 Skill 文件，按优先级从高到低：

| 范围 | 路径 |
|------|------|
| 当前项目 | `<项目根>/.opencode/skills/` |
| 用户全局 | `~/.config/opencode/skills/`（Windows：`%USERPROFILE%\.config\opencode\skills\`） |

**写入（memory-worker 沉淀 Skill）**

每次 Agent 对话结束后，memory-worker 会分析 trace 并将提炼出的 Skill 写入 `SKILL_WRITE_ROOT` 目录。默认路径：

| 系统 | 默认路径 |
|------|----------|
| macOS / Linux | `~/.claude/skills/` |
| Windows | `%USERPROFILE%\.claude\skills\` |

若希望 memory-worker 直接写入 OpenCode 的 Skill 目录（这样 OpenCode 下次对话就能自动引用），在 `.env.local` 里设置：

```env
# macOS 全局 Skill 目录
SKILL_WRITE_ROOT=/Users/you/.config/opencode/skills

# Windows 全局 Skill 目录
SKILL_WRITE_ROOT=C:\Users\you\.config\opencode\skills
```

---

### 在哪里查看 Trace？

运行期间产生的 trace 保存在：

```
memory_worker/logs/<timestamp>-<session-id>-<msg-id>/
  00-run.log          # 本次 pipeline 运行日志
  00-summary.json     # 上一轮 session 摘要
  01-trace.json       # 原始 trace（工具调用、消息完整记录）
  02-pool-summary.json# 候选 Skill 池摘要
  03-analyst-prompt.txt        # 发给分析模型的 prompt
  03a-analyzer-assistant-text.txt  # 分析模型的输出
  05-skill-suggestions.json   # 分析出的 Skill 建议
  06-writer-prompt.txt        # 发给写作模型的 prompt
  07-writer-result.json       # 最终写入的 Skill 内容
```

> 这些日志文件已加入 `.gitignore`，不会提交到仓库。

在浏览器中访问 http://127.0.0.1:5173，在 VibeTrace 界面里可以实时查看：
- **Session 列表** — 每个 OpenCode 会话
- **Action Flow** — 每一步工具调用的流程图
- **消息流** — 完整的 Agent 对话记录
- **Todo** — 任务进度

---

### 日常使用

1. 启动 **OpenCode 桌面端**（打开任意项目），或在 `cockpit-ui` 目录下运行 `opencode`
2. 等待浏览器自动打开；在 VibeTrace 中查看 Session、消息与 Action Flow
3. **无需**再手动执行 `npm run dev` 或 `npm run worker:py`

不想自动弹浏览器时：

```env
VIBETRACE_NO_BROWSER=1
```

---

## 手动启动（开发者 / 不用 Plugin 时）

若不使用 plugin，可按旧方式分别启动（需开多个终端）：

```bash
# 终端 1：OpenCode HTTP（若桌面端未自带）
opencode serve

# 终端 2：memory-worker
npm run worker:py

# 终端 3：前端
cp .env.example .env.local   # 并确认 OPENCODE_PROXY_TARGET 端口正确
npm run dev
```

浏览器访问 http://localhost:5173

---

## 常见问题

**Q：改了 plugin 代码没反应？**  
A：Plugin 只在 OpenCode **启动时**加载，需完全退出再开。

**Q：CLI 不自动开前端，桌面端可以？**  
A：检查全局 `opencode.json` 是否配置了 plugin **绝对路径**；或确认 CLI 是在 `cockpit-ui` 目录下运行的（使用相对路径时）。

**Q：控制台有 `memory-worker ingest failed`？**  
A：多为 `:8714` 未就绪；重启 OpenCode 或手动 `npm run worker:py` 排查。

**Q：浏览器弹出"登录"对话框？**  
A：这是 HTTP Basic 鉴权，不是账号登录。用户名 `opencode`，密码见 `.env.local` 中的 `VITE_OPENCODE_SERVER_PASSWORD`。Plugin 通常会自动写入密码并重启 Vite，若仍弹窗，手动关闭 `npm run dev` 后重启 OpenCode 即可。

---

## 仓库结构

```
cockpit-ui/
├── src/                     # VibeTrace 前端（需要根目录 npm install）
├── memory_worker/           # Python 后端（plugin 自动启动）
│   ├── server.py
│   ├── prompts/             # 分析/写作 prompt 模板
│   └── logs/                # 运行时 trace 日志（已 gitignore）
├── plugins/
│   └── agent-cockpit.ts     # OpenCode plugin：一键启动 VibeTrace
├── tools/
│   └── skill_router.ts      # 可选自定义工具：Skill 路由检索
├── opencode.json            # 项目级 plugin + tools 注册
├── .env.example             # 环境变量说明模板
└── package.json             # 前端依赖（不是 tools/plugins 的依赖）
```

| 你要用的 | 要不要单独装依赖 |
|----------|------------------|
| Plugin + Tools（`plugins/`、`tools/`） | 否，OpenCode（Bun）直接加载 `.ts` |
| VibeTrace UI（`src/`） | 是，`npm install`（在仓库根目录） |
| memory-worker | 本机 Python 3 即可 |

---

## Tech stack

React 19 · TypeScript · Vite · Tailwind CSS 4 · d3 · react-tooltip

---

## License

[MIT](./LICENSE)
