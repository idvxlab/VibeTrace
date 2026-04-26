/**
 * Harness 侧「引导语」：在发往 OpenCode 之前拼进本条 user 消息。
 *
 * 说明：
 * - OpenCode 内置的 system prompt 由本地 OpenCode 配置，HTTP `POST /session/:id/message`
 *   通常只接受用户消息的 parts，本面板无法直接覆盖服务端 system。
 * - 因此这里通过「用户消息前缀」实现同等引导效果；OpenCode 存的是完整拼接文本，界面展示时用 stripHarnessGuidanceForDisplay 只显示用户输入。
 *
 * 修改方式：直接改下面常量，或把 HARNESS_GUIDANCE_ENABLED 设为 false 关闭注入。
 */

/** 设为 false 时原样发送输入框内容，不附加任何引导。 */
export const HARNESS_GUIDANCE_ENABLED = true

/**
 * 每条用户消息前附加的引导（可按需改写）。
 * 建议保留「先计划、再执行」的结构，便于与子任务 / Todo 可视化对齐。
 */
export const HARNESS_USER_GUIDANCE = `[计划优先]回答用户输入前，总是先列出计划，使用todowrite工具生成todo,然后再执行。如果当前已有进行中的或部分完成的todo，不要完全新建todo,而是完全原样保留已有的已完成项，然后根据实际需要决定是修改未完成待办还是按照计划执行。`

/**
 * 引导与真实用户输入之间的固定分隔（须与发送逻辑一致；展示侧也用它识别截断点）。
 */
export const HARNESS_USER_INPUT_MARKER = '\n\n---\n【用户输入】\n'

export function buildUserMessageWithGuidance(rawUserText: string): string {
  const t = rawUserText.trimEnd()
  if (!HARNESS_GUIDANCE_ENABLED) return rawUserText
  return `${HARNESS_USER_GUIDANCE}${HARNESS_USER_INPUT_MARKER}${t}`
}

/**
 * 从存盘的 user 全文得到「仅用户输入」：所有对话里展示 / 复制用户消息前都应走此函数。
 *
 * 顺序：① 与当前 `HARNESS_USER_GUIDANCE + HARNESS_USER_INPUT_MARKER` 整段前缀；② 文中出现标准 `---` + `【用户输入】` 分隔时取其后（兼容引导文案改过、旧会话仍带 `[计划优先]…` 段落）。
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

  const markerNeedles = ['\n\n---\n【用户输入】\n', '\n---\n【用户输入】\n']
  for (const m of markerNeedles) {
    const idx = normalized.indexOf(m)
    if (idx >= 0) return normalized.slice(idx + m.length).trimStart()
  }

  const relaxed = /\n---\s*\n【用户输入】\s*\n/
  const match = normalized.match(relaxed)
  if (match?.index !== undefined) {
    return normalized.slice(match.index + match[0].length).trimStart()
  }

  return storedText
}
