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
export const HARNESS_USER_GUIDANCE = `
[Plan-first]
Before answering the user, outline a concise plan, use the todowrite tool to maintain todos, then execute.
[Runtime policy — must follow]
1) Before planning and execution: call \`skill_router\` with the task as \`query\` to discover skill candidates; if hits look relevant, load the best match with the built-in \`skill\` tool (exact \`name\`). If \`skill_router\` is unavailable, scan skill folders (e.g. \`.opencode/skills\`, \`~/.claude/skills\`) and use \`skill\` when a match applies.
2) Use todowrite during the planning phase (required).
3) If todos already exist:
   - Keep completed items (do not delete or mark as incomplete)
   - Keep in_progress items unless there is a clear conflict
   - Only add or modify pending items related to the current task
4) Before responding to the user, ensure todo statuses match actual execution results.

`

/** Separator between preamble and authentic user content — send + display parsers must agree. */
export const HARNESS_USER_INPUT_MARKER = '\n\n---\nUser input\n'

export function buildUserMessageWithGuidance(rawUserText: string): string {
  const t = rawUserText.trimEnd()
  if (!HARNESS_GUIDANCE_ENABLED) return rawUserText
  return `${HARNESS_USER_GUIDANCE}${HARNESS_USER_INPUT_MARKER}${t}`
}

/** Legacy transcript marker (pre-V1.5 harness) — Unicode escape avoids literal CJK in source */
const LEGACY_CN_USER_INPUT_MARKER = '\u3010\u7528\u6237\u8f93\u5165\u3010'
const LEGACY_USER_INPUT_MARKER = `\n\n---\n${LEGACY_CN_USER_INPUT_MARKER}\n`
const LEGACY_USER_INPUT_MARKER_TIGHT = `\n---\n${LEGACY_CN_USER_INPUT_MARKER}\n`

/**
 * Recover the user's visible text from persisted rows — call this everywhere user bubbles render or copy text.
 *
 * Order: strip the active `HARNESS_USER_GUIDANCE + HARNESS_USER_INPUT_MARKER` prefix; else look for `---` +
 * `User input`, the previous Chinese marker, or legacy pre-V1.5 markers.
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
    '\n---\n用户输入\n',
    LEGACY_USER_INPUT_MARKER,
    LEGACY_USER_INPUT_MARKER_TIGHT,
  ]
  for (const m of markerNeedles) {
    const idx = normalized.indexOf(m)
    if (idx >= 0) return normalized.slice(idx + m.length).trimStart()
  }

  const relaxed = new RegExp(
    `\\n---\\s*\\n(?:User input|用户输入|${LEGACY_CN_USER_INPUT_MARKER})\\s*\\n`,
  )
  const match = normalized.match(relaxed)
  if (match?.index !== undefined) {
    return normalized.slice(match.index + match[0].length).trimStart()
  }

  return storedText
}
