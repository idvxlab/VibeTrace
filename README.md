# Agent Cockpit（cockpit-ui）

面向 [OpenCode](https://opencode.ai/) 的 Web 控制台：通过 HTTP/SSE 连接本机 OpenCode 服务，管理多目录会话、消息流、Todo、子任务可视化与动作流分析等。

---

## 一、如何使用与启动

### 1. 安装 OpenCode CLI

本前端依赖本机运行的 OpenCode **无头 HTTP 服务**，请先安装命令行工具。任选其一即可（详见 [官方安装说明](https://opencode.ai/docs/)）：

安装后确认：

```bash
opencode --version
```

### 2. 启动 OpenCode HTTP 服务

这一步可以理解成：先把后端服务开起来，前端再去连它。

先在命令行执行：

```bash
opencode serve
```

正常会看到类似：

```text
opencode server listening on http://127.0.0.1:4096
```

上面最后的数字就是端口号。  
如果不是 `4096`，修改`.env.local`中端口，如果没有`.env.local`文件，复制`.env.example`并重命名为`.env.local`

```env
VITE_OPENCODE_BASE=http://127.0.0.1:这里换成你终端显示的端口
```

你也可以直接指定端口启动（例如 4096）：

```bash
opencode serve --port 4096
```

### 3. 安装并启动本前端

```bash
npm install
npm run dev
```

默认开发服务器：**<http://localhost:5173>**（见 `vite.config.ts`）。

在浏览器打开上述地址即可使用；并确保 `opencode serve` 的终端窗口保持运行。

### 4. 环境变量说明（`.env.local`）

建议先复制模板：

```bash
cp .env.example .env.local
```

常用变量：

- `VITE_OPENCODE_BASE`：前端请求 OpenCode 的地址。你每次启动 `opencode serve` 后，看终端输出地址填这里即可。
- `VITE_OPENCODE_DEFAULT_MODEL`（可选）：默认模型，格式是 `provider/model`。  
  不配也能用，前端会走 OpenCode 服务端自己的默认模型。只有你想固定模型时才需要填。模型获取修改逻辑开发中（todo)



---

## 二、项目结构说明

### 根目录

| 路径 | 内容概要 |
| --- | --- |
| `package.json` / `package-lock.json` | 依赖与脚本（Vite、React 19、Tailwind 4、d3 等） |
| `vite.config.ts` | Vite + React + `@tailwindcss/vite`；开发端口 `5173` |
| `tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json` | TypeScript 工程与引用配置 |
| `eslint.config.js` | ESLint 扁平配置 |
| `index.html` | 单页入口，标题「Agent Cockpit」，引入字体与 `/src/main.tsx` |
| `.gitignore` | Git 忽略规则 |
| `.env.example` | 可提交的环境变量模板（本地真实配置放 `.env.local`） |

### `public/`

静态资源：如 `favicon.svg`、`icons.svg`，构建时原样拷贝。

### `scripts/`

| 路径 | 内容概要 |
| --- | --- |
| `smoke-opencode-session.mjs` | 终端脚本：请求 `GET /global/health`、`GET /config`、`POST /session`，用于排查 OpenCode 是否就绪、目录头是否正确 |

### `src/` 应用源码

| 路径 | 内容概要 |
| --- | --- |
| `main.tsx` | React 挂载、`StrictMode`、`ErrorBoundary`、全局样式与 `react-tooltip` 样式 |
| `App.tsx` | 顶层状态与编排：会话列表、当前目录/会话、消息与 Todo 拉取、SSE 订阅、发送/中止/分叉、子任务与动作分析联动等 |
| `ErrorBoundary.tsx` | 运行时错误边界，避免整页白屏 |
| `index.css` | 全局样式与设计变量（注释中说明来自 OpenCode 设计体系） |

#### `src/services/`

| 路径 | 内容概要 |
| --- | --- |
| `opencodeApi.ts` | 与 OpenCode 交互的核心：REST（会话、消息、Todo、提问回复等）与 SSE（全局/工作区事件），默认基址 `http://127.0.0.1:4096`，多项目时带 `x-opencode-directory` |

#### `src/types/`

| 路径 | 内容概要 |
| --- | --- |
| `opencode.ts` | OpenCode API 相关的 TypeScript 类型：会话、消息 parts、Todo、工具调用、SSE 事件、待回答问题等 |

#### `src/config/`

| 路径 | 内容概要 |
| --- | --- |
| `harnessGuidance.ts` | 发往模型前可选的「用户消息前缀」引导（计划/Todo 等）；展示时可剥离前缀，仅显示真实用户输入 |

#### `src/utils/`

| 路径 | 内容概要 |
| --- | --- |
| `opencodeSse.ts` | 解析全局 SSE 中与动作相关的事件（如权限、压缩等） |
| `sessionFolders.ts` | 会话目录归一化、展示名、从会话列表提取目录集合 |
| `messageAttachments.ts` | 消息附件相关处理 |
| `questionPart.ts` | 判断消息中是否存在待回答的 question 等 |
| `todoRegistry.ts` | 从消息与 Todo 列表构建规范化的 Todo 模型、归档与 todowrite 批次进度 |
| `subtaskGrouping.ts` | 将助手消息划分子任务、识别 todowrite 等 |
| `subtaskLinkage.ts` | 子任务与 Todo 下标/链接逻辑 |
| `subtaskMetrics.ts` | 子任务指标计算 |
| `actionMapping.ts` | 从消息映射为动作流可视化所需的 `MappedAction` 等 |

#### `src/styles/`

| 路径 | 内容概要 |
| --- | --- |
| `actionFlowPalette.ts` | 动作流图中节点/连线的配色常量 |

#### `src/components/`（UI 组件）

| 路径 | 内容概要 |
| --- | --- |
| `Header.tsx` | 顶栏（连接状态、标题等） |
| `Sidebar.tsx` | 左侧：目录切换、会话列表、新建会话、折叠 |
| `MessagePanel.tsx` | 中间主栏：消息列表、输入框、Todo 面板、待回答问题、会话标题编辑 |
| `MessageBubble.tsx` | 单条消息气泡（文本、推理、工具调用等 parts） |
| `MessageInput.tsx` | 输入与发送载荷（含附件等扩展） |
| `ReasoningBlock.tsx` | 推理内容展示 |
| `ToolCallCard.tsx` | 工具调用卡片 |
| `TodoPanel.tsx` / `FixedTodoPanel.tsx` | Todo 列表展示（含固定/嵌入式等布局差异） |
| `QuestionPromptPanel.tsx` | OpenCode question 工具的交互式作答 UI |
| `SubtaskCard.tsx` | 单个子任务卡片 |
| `SubtaskDebugPanel.tsx` | 子任务调试信息侧栏 |
| `SubtaskMessageConnector.tsx` | 子任务与消息之间的连线/高亮联动 |
| `EventFlowChart.tsx` | 基于 d3 的「事件流」条状图（从消息中提取工具/写文件等事件） |
| `ActionFlowVisualization.tsx` | 动作流主可视化（d3 + 泳道/节点、与 `actionMapping` 布局一致） |
| `ActionFlowContextMenu.tsx` | 动作流上的右键菜单 |
| `actionFlowIcons.ts` | 动作流节点图标 SVG 等 |
| `ActionAnalysisModal.tsx` | 动作分析弹层 |

### `docs/`（设计备忘，非运行时依赖）

内部说明文档，例如动作映射、子任务字段、前后端数据与联动等，便于开发与维护时查阅。

---

## 技术栈摘要

- **React 19** + **TypeScript** + **Vite 8**
- **Tailwind CSS 4**（`@tailwindcss/vite`）
- **d3**、**react-tooltip**：图表与提示

若 OpenCode 或本仓库接口有升级，请以运行中的 `opencode serve` 与 `src/services/opencodeApi.ts` 为准进行对齐。
