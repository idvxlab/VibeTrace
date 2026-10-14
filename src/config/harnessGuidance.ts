/**
 * 注入到每条发往 OpenCode 的用户消息前的 harness 前缀。
 *
 * 说明：
 * - OpenCode 的 system prompt 仍在服务端 — `POST /session/:id/message` 通常只带 user parts，
 *   因此 UI 无法直接覆盖 system。
 * - 我们通过 user 消息前缀近似同样效果；持久化 transcript 含完整字符串，
 *   `stripHarnessGuidanceForDisplay` 在聊天气泡中只显示用户撰写部分。
 *
 * 用 `HARNESS_GUIDANCE_ENABLED` 开关，或直接编辑下方字符串。
 */

/** 为 false 时，原样发送输入框文字（无前缀）。 */
export const HARNESS_GUIDANCE_ENABLED = true

/**
 * 每条用户轮次前拼接的前缀（可自由编辑）。
 * 保持「先计划再执行」形态，便于子任务 / todo 可视化有意义。
 */
export const HARNESS_USER_GUIDANCE = `
[先计划后执行]
在回答用户前，先列出简明计划，用 todowrite 工具维护待办，再执行。
[运行时策略 — 必须遵守]
1) 计划与执行前：以任务为 \`query\` 调用 \`skill_router\` 发现 skill 候选；若命中相关，用内置 \`skill\` 工具（精确 \`name\`）加载最佳匹配。若 \`skill_router\` 不可用，扫描 skill 目录（如 \`.opencode/skills\`、\`~/.claude/skills\`），有匹配则用 \`skill\`。
2) 计划阶段必须使用 todowrite（必填）。
3) 若已有 todos：
   - 保留已完成项（不要删除或标回未完成）
   - 保留 in_progress 项，除非有明确冲突
   - 仅新增或修改与当前任务相关的 pending 项
4) 回复用户前，确保 todo 状态与实际执行结果一致。

`

/** 前缀与真实用户内容之间的分隔符 — 发送与展示解析须一致。 */
export const HARNESS_USER_INPUT_MARKER = '\n\n---\n用户输入\n'

export function buildUserMessageWithGuidance(rawUserText: string): string {
  const t = rawUserText.trimEnd()
  if (!HARNESS_GUIDANCE_ENABLED) return rawUserText
  return `${HARNESS_USER_GUIDANCE}${HARNESS_USER_INPUT_MARKER}${t}`
}

/** 旧版 transcript 标记（V1.5 前 harness）— Unicode 转义避免源码中出现字面 CJK */
const LEGACY_CN_USER_INPUT_MARKER = '\u3010\u7528\u6237\u8f93\u5165\u3010'
const LEGACY_USER_INPUT_MARKER = `\n\n---\n${LEGACY_CN_USER_INPUT_MARKER}\n`
const LEGACY_USER_INPUT_MARKER_TIGHT = `\n---\n${LEGACY_CN_USER_INPUT_MARKER}\n`

/**
 * 从持久化行中恢复用户可见文字 — 所有用户气泡渲染或复制文本处都应调用。
 *
 * 顺序：剥掉当前 `HARNESS_USER_GUIDANCE + HARNESS_USER_INPUT_MARKER` 前缀；否则查找 `---` +
 * `用户输入` 或旧版英文/中文标记。
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
    '\n---\n用户输入\n',
    '\n---\nUser input\n',
    LEGACY_USER_INPUT_MARKER,
    LEGACY_USER_INPUT_MARKER_TIGHT,
  ]
  for (const m of markerNeedles) {
    const idx = normalized.indexOf(m)
    if (idx >= 0) return normalized.slice(idx + m.length).trimStart()
  }

  const relaxed = new RegExp(
    `\\n---\\s*\\n(?:用户输入|User input|${LEGACY_CN_USER_INPUT_MARKER})\\s*\\n`,
  )
  const match = normalized.match(relaxed)
  if (match?.index !== undefined) {
    return normalized.slice(match.index + match[0].length).trimStart()
  }

  return storedText
}
