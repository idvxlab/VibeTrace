/**
 * OpenCode 自定义工具：复制到目标仓库 `.opencode/tools/skill_router.ts`。
 * 依赖 `@opencode-ai/plugin`（与官方 Custom Tools 一致）。
 *
 * 设计说明：`execute` 的**契约**应对齐内置 `skill` 工具在
 * `packages/opencode/src/tool/skill.ts` 中返回给模型的形状（`title` + `output` 含
 * `<skill_content name="…">` + `metadata: { name, dir }`），便于日后把「路由选中的一条技能」
 * 无缝换成真实内容。当前实现仅为固定占位，**不得**当作已加载的真实 skill 执行。
 */
import { tool } from '@opencode-ai/plugin'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 占位用「技能名」：明显非法/示意性，避免与真实 skill 撞名 */
const PLACEHOLDER_SKILL_NAME = '__skill_router_placeholder__'

function buildPlaceholderSkillOutput(dir: string, baseHref: string): string {
  return [
    `<skill_content name="${PLACEHOLDER_SKILL_NAME}">`,
    `# Skill: ${PLACEHOLDER_SKILL_NAME}`,
    '',
    '【PLACEHOLDER / 占位符 — 勿当作真实 SKILL 内容执行】',
    '',
    '此块由 `skill_router` 工具**临时固定输出**，用于锁定与 OpenCode 内置 `skill` 工具相同的 `output` 排版（含 `<skill_content>` / `<skill_files>` 段落）。',
    '',
    '- **当前未**接入任何搜索、匹配或排序算法；未读取磁盘上的 SKILL.md。',
    '- **后续**：在此填入检索算法选中的**唯一**技能的完整正文与资源提示，并令 `title` / `metadata.name` / `metadata.dir` 与真实 skill 一致。',
    '',
    `Base directory for this skill: ${baseHref}`,
    'Relative paths in this skill (e.g., scripts/, reference/) would be relative to this base directory.',
    'Note: file list below is **placeholder only** (no files sampled).',
    '',
    '<skill_files>',
    '<!-- PLACEHOLDER: future implementation will list sibling files like built-in skill tool -->',
    '</skill_files>',
    '</skill_content>',
  ].join('\n')
}

export default tool({
  description: [
    '[Routing — plan phase]',
    'Call **once per user turn** before detailed planning when workspace policy requires routing user intent to at most **one** specialized skill.',
    '',
    '**Purpose (target behavior, not yet implemented):**',
    'Given natural-language `query` (and optional `context`), run a **skill search & matching** pipeline over the same skill roots OpenCode uses (e.g. `.opencode/skills`, `~/.config/opencode/skills`, `.claude/skills`, …), score candidates, and return **exactly one** winning skill in the **same structural shape** as the built-in `skill` tool output — so the model can treat the result like a loaded skill block (`title`, multi-line `output` starting with `<skill_content name="…">`, and `metadata: { name, dir }`).',
    '',
    '**Current behavior:**',
    'Implementation is a **stub**. The tool returns a **fixed JSON string** that mirrors that shape with explicit `implementation_status: "placeholder"` and fake `metadata`. **Do not** follow the placeholder body as real procedures; do **not** assume any skill was loaded. Still call it when policy asks, so transcripts and UI keep a stable contract until the algorithm is wired in.',
    '',
    '**When to use:**',
    '- User or system harness asks for plan-first workflow and names `skill_router`.',
    '- You need a single routed skill decision before `todowrite` / execution.',
    '',
    '**When not to use:**',
    '- To load a skill by exact name — use the built-in `skill` tool with `name` from `available_skills` instead.',
  ].join('\n'),
  args: {
    query: tool.schema
      .string()
      .describe(
        'Current user task or subtask in short natural language; will drive future retrieval / ranking (not used for matching today).',
      ),
    context: tool.schema
      .string()
      .optional()
      .describe(
        'Optional: workspace path hints, stack, constraints, locale; reserved for future ranker features.',
      ),
    top_k: tool.schema
      .number()
      .min(1)
      .max(50)
      .default(5)
      .describe(
        'Reserved: future pipeline may use this as max internal candidates before selecting one winner; placeholder output only echoes it.',
      ),
  },
  async execute(args, context) {
    const worktree = context.worktree || context.directory
    const placeholderDir = path.join(worktree, '.opencode', 'skills', PLACEHOLDER_SKILL_NAME)
    const baseHref = pathToFileURL(placeholderDir).href
    const topK = args.top_k ?? 5

    context.metadata({
      title: `Skill router (placeholder): ${args.query.slice(0, 48)}${args.query.length > 48 ? '…' : ''}`,
      metadata: {
        skill_router: true,
        implementation_status: 'placeholder',
      },
    })

    const outputBody = buildPlaceholderSkillOutput(placeholderDir, baseHref)

    const envelope = {
      _skill_router_meta: {
        implementation_status: 'placeholder' as const,
        do_not_execute_as_real_skill: true,
        contract_note:
          'Outer keys `title`, `output`, `metadata` intentionally mirror OpenCode built-in `skill` tool execute result (see opencode src/tool/skill.ts) for forward compatibility.',
        future_work:
          'Replace placeholder `output` with real SKILL.md body and set `metadata.name` / `metadata.dir` to the winning skill; keep a single winner.',
      },
      title: `Loaded skill: ${PLACEHOLDER_SKILL_NAME}`,
      output: outputBody,
      metadata: {
        name: PLACEHOLDER_SKILL_NAME,
        dir: placeholderDir,
      },
      request_echo: {
        query: args.query,
        context: args.context ?? null,
        top_k: topK,
      },
    }

    return JSON.stringify(envelope, null, 2)
  },
})
