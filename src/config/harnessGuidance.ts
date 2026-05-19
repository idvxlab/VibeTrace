/**
 * Harness preamble injected before each outbound user message to OpenCode.
 *
 * Notes:
 * - OpenCode system prompts remain server-side — `POST /session/:id/message` usually only carries user parts,
 *   so this UI cannot override system directly.
 * - We approximate the same effect via a user-message prefix; stored transcripts include the full string while
 *   `stripHarnessGuidanceForDisplay` shows only the user-authored portion in the chat column.
 *
 * Toggle with `HARNESS_GUIDANCE_ENABLED` or edit the strings below.
 */

/** When false, send the composer text exactly as typed (no preamble). */
export const HARNESS_GUIDANCE_ENABLED = true

/**
 * Preamble prepended to every user turn (edit freely).
 * Keep a plan-then-execute shape so subtask / todo visualizations stay meaningful.
 */
export const HARNESS_USER_GUIDANCE = `[Runtime policy / 必须遵守]
1) 在任何计划与执行之前，先调用自定义工具 skill_router（不可跳过）
2) 读取 skill_router 返回的技能候选与说明后，目前skill_router尚未实现，请你自行判断当前任务是否有使用的skill，如果有匹配的skill选择并使用，然后再进入计划阶段。
3) 计划阶段必须使用 todowrite。
4) 如果已有 todo：
   - 保留 completed 项（不得删除或改写为未完成）
   - 保留 in_progress 项，除非有明确冲突再调整
   - 仅新增/修改当前任务相关的未完成项
5) 给用户输出前，确保 todo 状态与实际执行结果一致。

[Tool contract: skill_router]
- 目的：根据当前任务路由最相关 skills，并返回可供后续计划使用的结构化结果。
- 必填参数：
  {
    "query": "string",
    "context": "string (optional)",
    "top_k": "number (optional, default 5)"
  }
- 返回结构（当前为占位实现）：
  {
    "status": "placeholder",
    "message": "skill_router: TODO_IMPLEMENTATION",
    "query_echo": "<original query>",
    "hits": []
  }

[Plan-first]
Before answering the user, outline a concise plan, use the todowrite tool to maintain todos, then execute.`

/** Separator between preamble and authentic user content — send + display parsers must agree. */
export const HARNESS_USER_INPUT_MARKER = '\n\n---\nUser input\n'

export function buildUserMessageWithGuidance(rawUserText: string): string {
  const t = rawUserText.trimEnd()
  if (!HARNESS_GUIDANCE_ENABLED) return rawUserText
  return `${HARNESS_USER_GUIDANCE}${HARNESS_USER_INPUT_MARKER}${t}`
}

/** Legacy harness markers (literal Chinese) — retained so older transcripts still strip correctly. */
const LEGACY_USER_INPUT_MARKER = '\n\n---\n【用户输入】\n'
const LEGACY_USER_INPUT_MARKER_TIGHT = '\n---\n【用户输入】\n'

/**
 * Recover the user's visible text from persisted rows — call this everywhere user bubbles render or copy text.
 *
 * Order: strip the active `HARNESS_USER_GUIDANCE + HARNESS_USER_INPUT_MARKER` prefix; else look for `---` +
 * `User input` / legacy `【用户输入】` markers (handles older Chinese harness text).
 */
export function stripHarnessGuidanceForDisplay(storedText: string): string {
  if (!storedText) return storedText
  const normalized = storedText.replace(/\r\n/g, '\n')

  if (HARNESS_GUIDANCE_ENABLED) {
    const exactPrefix = `${HARNESS_USER_GUIDANCE}${HARNESS_USER_INPUT_MARKER}`
    if (normalized.startsWith(exactPrefix)) {
      return normalized.slice(exactPrefix.length).trimStart()
    }
  }

  const markerNeedles = [
    `${HARNESS_USER_INPUT_MARKER}`,
    '\n---\nUser input\n',
    LEGACY_USER_INPUT_MARKER,
    LEGACY_USER_INPUT_MARKER_TIGHT,
  ]
  for (const m of markerNeedles) {
    const idx = normalized.indexOf(m)
    if (idx >= 0) return normalized.slice(idx + m.length).trimStart()
  }

  const relaxed = /\n---\s*\n(?:User input|【用户输入】)\s*\n/
  const match = normalized.match(relaxed)
  if (match?.index !== undefined) {
    return normalized.slice(match.index + match[0].length).trimStart()
  }

  return storedText
}
