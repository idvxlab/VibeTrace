# `.opencode/tools`（拷贝到 OpenCode）

本目录放 **OpenCode Custom Tools** 的参考实现。**文件名（不含 `.ts/.js`）即工具名**。

## 放置位置（OpenCode 官方约定）

| 范围 | 路径 |
|------|------|
| 当前仓库 / 工程 | `<项目根>/.opencode/tools/` |
| 当前用户全局 | `~/.config/opencode/tools/` |

将单个文件复制到对应 `tools/` 下即可生效（需运行时提供 `@opencode-ai/plugin`，与官方文档一致）。

## 与本仓库 Trace / Memory Worker 的关系

| 链路 | 说明 |
|------|------|
| **Trace 收集（关键）** | 由 **Cockpit UI** 在 assistant `finish: stop` 后构建 `trace.v1`，HTTP **POST → Memory Worker `:8714/ingest-trace`**。**不依赖**本目录工具。详见 **[docs/memory-worker.md](../docs/memory-worker.md)** 第 6 节。 |
| **本目录工具**（如 `skill_router.ts`） | 供 **Agent 在 OpenCode 里调用**（计划前路由 skills 等），需在 **OpenCode 侧**部署；Trace 仍会照常由 Cockpit 发给 Worker，两者职责不同但可配合同一套 harness（先 `skill_router` 再起 plan）。 |

## 现有文件

- **`skill_router.ts`** — 占位版 `skill_router` 工具，返回结构与内置 `skill` 工具对齐，便于日后接真实检索逻辑。复制到你在用的 OpenCode 工程即可。
