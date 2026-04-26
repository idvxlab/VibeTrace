import type {
  OcSession,
  OcTodo,
  OcMessage,
  OcPendingQuestionItem,
} from '../types/opencode'

/**
 * OpenCode HTTP 基址（须与终端里 `opencode serve` 打印的地址一致）。
 * - 最省事：项目根建 `.env.local`，写一行 `VITE_OPENCODE_BASE=http://127.0.0.1:61830`（换成你的端口），保存后重启 `npm run dev`
 * - 或直接改下面默认 return 的 URL
 */
function resolveOpencodeBase(): string {
  const raw = import.meta.env.VITE_OPENCODE_BASE
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim().replace(/\/$/, '')
  }
  // 与 github.com/Alphake/opencode_vis main 默认一致；本机端口不同请用 .env.local 的 VITE_OPENCODE_BASE
  return 'http://127.0.0.1:4096'
}

const BASE = resolveOpencodeBase()

const LOG = {
  http: '[OpenCode · HTTP]',
  /** 控制台里 Ctrl+F 搜这个，可快速跳到各接口「有 body 的」响应摘要（与上面的请求日志成对） */
  httpResp: '[OC·HTTP·RESP]',
  sseRaw: '[OpenCode · SSE · 原始 data 字符串]',
  sseParsed: '[OpenCode · SSE · 解析后 JSON]',
} as const

function clip(s: string, n = 1200): string {
  if (s.length <= n) return s
  return `${s.slice(0, n)}… (${s.length} chars)`
}

/**
 * OpenCode `POST /session/:id/message` 的 `model` 须为对象 `{ providerID, modelID }`，不能传 `provider/model` 字符串。
 * 环境变量里仍写 `deepseek/deepseek-reasoner` 这种形式，此处按第一个 `/` 拆开。
 */
function parseModelRefToBody(ref: string): { providerID: string; modelID: string } | undefined {
  const t = ref.trim()
  const i = t.indexOf('/')
  if (i <= 0 || i >= t.length - 1) return undefined
  const providerID = t.slice(0, i).trim()
  const modelID = t.slice(i + 1).trim()
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

/**
 * 与 [OpenCode 服务器文档 · 认证](https://opencode.ai/docs/zh-cn/server/#%E8%AE%A4%E8%AF%81) 一致：
 * 若启动时设置了 `OPENCODE_SERVER_PASSWORD`，则所有 HTTP（含 fetch、SSE）需带 Basic 认证，否则浏览器端会 401。
 * 在 cockpit 侧设置 `VITE_OPENCODE_SERVER_PASSWORD`（及可选 `VITE_OPENCODE_SERVER_USERNAME`，默认 `opencode`）。
 */
function basicAuthHeader(): Record<string, string> {
  const pwd = import.meta.env.VITE_OPENCODE_SERVER_PASSWORD
  if (typeof pwd !== 'string' || !pwd.trim()) return {}
  const user =
    typeof import.meta.env.VITE_OPENCODE_SERVER_USERNAME === 'string' &&
    import.meta.env.VITE_OPENCODE_SERVER_USERNAME.trim()
      ? import.meta.env.VITE_OPENCODE_SERVER_USERNAME.trim()
      : 'opencode'
  const raw = `${user}:${pwd}`
  const bytes = new TextEncoder().encode(raw)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return { Authorization: `Basic ${btoa(bin)}` }
}

/** 多项目目录 + 可选 HTTP Basic（见上）。 */
function withDirectoryHeaders(base: Record<string, string>, directory?: string): Record<string, string> {
  const out = { ...base, ...basicAuthHeader() }
  if (directory) out['x-opencode-directory'] = directory
  return out
}

function normalizeDirectoryLike(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return null
  return t.replace(/\\/g, '/').replace(/\/+$/, '')
}

function extractProjectDirectory(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null
  const obj = item as Record<string, unknown>
  const candidates = [
    obj.worktree,
    obj.directory,
    obj.path,
    obj.root,
    obj.cwd,
    (obj.path as Record<string, unknown> | undefined)?.directory,
  ]
  for (const c of candidates) {
    const n = normalizeDirectoryLike(c)
    if (n) return n
  }
  return null
}

// ===== REST API =====

export async function getSessions(options?: { directory?: string }): Promise<OcSession[]> {
  const url = `${BASE}/session`
  console.log(`${LOG.http} GET 会话列表`, url, options?.directory ? { directory: options.directory } : '')
  const res = await fetch(url, { headers: withDirectoryHeaders({}, options?.directory) })
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`)
  const data = await res.json()
  console.log(`${LOG.http} GET /session 响应`, Array.isArray(data) ? `${data.length} sessions` : data)
  return data
}

/** 从官方 `/project` + `/project/current` 构建项目目录列表（用于左栏目录来源）。 */
export async function getProjectDirectories(): Promise<string[]> {
  const set = new Set<string>()

  const pull = async (url: string, label: string) => {
    const res = await fetch(url, { headers: withDirectoryHeaders({}) })
    if (!res.ok) {
      throw new Error(`${label} failed: ${res.status}`)
    }
    const data = await res.json()
    const list = Array.isArray(data) ? data : [data]
    for (const item of list) {
      const dir = extractProjectDirectory(item)
      if (dir) set.add(dir)
    }
  }

  try {
    await pull(`${BASE}/project`, 'GET /project')
  } catch (e) {
    console.warn(`${LOG.http} GET /project 失败，忽略并继续`, e)
  }
  try {
    await pull(`${BASE}/project/current`, 'GET /project/current')
  } catch (e) {
    console.warn(`${LOG.http} GET /project/current 失败，忽略并继续`, e)
  }

  const out = [...set]
  console.log(`${LOG.http} 项目目录列表`, out.length, out)
  return out
}

/** `GET /path`：读取服务端当前 workspace 路径，兼容不同字段形态。 */
export async function getCurrentWorkspaceDirectory(): Promise<string | null> {
  const res = await fetch(`${BASE}/path`, { headers: withDirectoryHeaders({}) })
  if (!res.ok) {
    throw new Error(`GET /path failed: ${res.status}`)
  }
  const data = await res.json()
  if (typeof data === 'string') return normalizeDirectoryLike(data)
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    const dir =
      normalizeDirectoryLike(obj.directory) ||
      normalizeDirectoryLike(obj.path) ||
      normalizeDirectoryLike(obj.cwd) ||
      normalizeDirectoryLike(obj.root)
    if (dir) return dir
  }
  return null
}

/**
 * 新建会话。可选 `directory` 会通过 `x-opencode-directory` 传给 OpenCode，与桌面/Web 多项目切换一致。
 * 不传则使用服务端当前工作区目录。
 *
 * 部分版本在带 directory 创建时会返回 **200 但 body 为空**；此时会再拉取该目录下的 session 列表并取最新一条作为新建结果。
 */
export async function createSession(directory?: string): Promise<OcSession> {
  const url = `${BASE}/session`
  const headers = withDirectoryHeaders({ 'Content-Type': 'application/json' }, directory)
  console.log(`${LOG.http} POST 新建会话`, url, directory ? { directory } : {})
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.status} ${bodyText}`)
  }
  const trimmed = bodyText.trim()
  if (trimmed) {
    try {
      const data = JSON.parse(trimmed) as OcSession
      console.log(`${LOG.http} POST /session 响应`, data?.id, data?.directory)
      return data
    } catch {
      console.warn(`${LOG.http} POST /session 200 但 JSON 解析失败`, clip(trimmed, 400))
    }
  } else {
    console.warn(
      `${LOG.http} POST /session 200 且 body 为空，改为 GET /session?directory=… 取最新会话（OpenCode 多目录已知行为）`,
    )
  }

  const list = await getSessions(directory ? { directory } : undefined)
  const sorted = [...list].sort((a, b) => b.time.updated - a.time.updated)
  const pick = sorted[0]
  if (!pick) {
    throw new Error(
      'Create session: empty response and no sessions returned for this directory. Check OpenCode server logs.',
    )
  }
  console.log(`${LOG.http} 选用列表最新会话作为新建结果`, pick.id, pick.directory)
  return pick
}

/** PATCH /session/:id，更新标题（OpenCode：session.update） */
export async function updateSessionTitle(
  sessionId: string,
  title: string,
  directory?: string,
): Promise<OcSession> {
  const url = `${BASE}/session/${sessionId}`
  console.log(`${LOG.http} PATCH 会话标题`, url, { title: clip(title, 80) }, directory ? { directory } : '')
  const res = await fetch(url, {
    method: 'PATCH',
    headers: withDirectoryHeaders({ 'Content-Type': 'application/json' }, directory),
    body: JSON.stringify({ title }),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`Failed to update session title: ${res.status} ${bodyText}`)
  }
  const data = JSON.parse(bodyText) as OcSession
  console.log(`${LOG.http} PATCH /session 响应`, data?.id, data?.title)
  return data
}

/**
 * 删除会话（OpenCode: `DELETE /session/:id`）。
 * 会从服务端移除该会话及全部消息；公开 API 无单独的「仅隐藏、可恢复」归档端点，与 TUI 中从历史里拿掉会话的效果一致。
 */
export async function deleteSession(sessionId: string, directory?: string): Promise<void> {
  const url = `${BASE}/session/${sessionId}`
  console.log(`${LOG.http} DELETE 会话`, url, directory ? { directory } : '')
  const res = await fetch(url, {
    method: 'DELETE',
    headers: withDirectoryHeaders({}, directory),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`deleteSession failed: ${res.status} ${bodyText}`)
  }
  if (bodyText) {
    try {
      console.log(`${LOG.http} DELETE /session 响应`, JSON.parse(bodyText))
    } catch {
      console.log(`${LOG.http} DELETE /session 响应`, clip(bodyText, 200))
    }
  }
}

export async function getTodos(sessionId: string, directory?: string): Promise<OcTodo[]> {
  const url = `${BASE}/session/${sessionId}/todo`
  console.log(`${LOG.http} GET todos`, url, directory ? { directory } : '')
  const res = await fetch(url, { headers: withDirectoryHeaders({}, directory) })
  if (!res.ok) throw new Error(`Failed to fetch todos: ${res.status}`)
  const data = await res.json()
  console.log(`${LOG.http} GET /todo 响应`, data.length, '条', data)
  return data
}

export async function getMessages(sessionId: string, reason?: string, directory?: string): Promise<OcMessage[]> {
  const url = `${BASE}/session/${sessionId}/message`
  console.log(`${LOG.http} GET 消息列表（完整对话 JSON）`, url, reason ? `← ${reason}` : '', directory ? { directory } : '')
  const res = await fetch(url, { headers: withDirectoryHeaders({}, directory) })
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`)
  const data = await res.json()
  console.log(`${LOG.httpResp} GET /message`, {
    url,
    status: res.status,
    count: Array.isArray(data) ? data.length : -1,
    note: '完整对话 JSON；正文以本接口为准，不在 SSE 里',
  })
  console.log(`${LOG.http} GET /message 响应: ${data.length} 条消息（正文以本接口为准，不在 SSE 里）`)
  data.forEach((msg: OcMessage, i: number) => {
    console.log(`  [${i}] role=${msg.info.role}, parts=${msg.parts.length}, id=${msg.info.id}`)
    msg.parts.forEach((part, j) => {
      console.log(`       part[${j}]: type=${part.type}`)
    })
  })
  return data
}

/** 与 OpenCode POST /session/:id/message 对齐；服务端会为 part 补全 id */
export type UserMessagePartBody =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { type: string; media_type: string; data: string }
    }

/**
 * 发送用户消息。`text` 为单条 text part（通常已含 harness 引导）；`images` 会先作为 image parts 再跟 text（便于视觉模型）。
 *
 * `model`：可传 `provider/model` 字符串（与 env 一致），发送时会转为 `{ providerID, modelID }`。
 * `agent` 对应同一请求体里的 `agent` 字段（字符串）。
 */
export async function sendMessage(
  sessionId: string,
  text: string,
  directory?: string,
  options?: {
    imageParts?: Array<{ media_type: string; data: string }>
    model?: string
    agent?: string
  },
): Promise<void> {
  const url = `${BASE}/session/${sessionId}/message`
  const imageParts: UserMessagePartBody[] = (options?.imageParts ?? []).map((img) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: img.media_type,
      data: img.data,
    },
  }))
  const parts: UserMessagePartBody[] = [...imageParts, { type: 'text', text }]
  const modelRef =
    (options?.model && options.model.trim()) ||
    (typeof import.meta.env.VITE_OPENCODE_DEFAULT_MODEL === 'string' && import.meta.env.VITE_OPENCODE_DEFAULT_MODEL.trim()) ||
    undefined
  const modelBody = modelRef ? parseModelRefToBody(modelRef) : undefined
  const agent =
    (options?.agent && options.agent.trim()) ||
    (typeof import.meta.env.VITE_OPENCODE_DEFAULT_AGENT === 'string' && import.meta.env.VITE_OPENCODE_DEFAULT_AGENT.trim()) ||
    undefined
  const reqBody: Record<string, unknown> = { parts }
  if (modelBody) reqBody.model = modelBody
  if (agent) reqBody.agent = agent
  if (modelRef && !modelBody) {
    console.warn(
      `${LOG.http} model 无法解析为 provider/model（需含一个 /）：`,
      JSON.stringify(modelRef),
      '已省略 model 字段',
    )
  }
  console.log(
    `${LOG.http} POST 发送用户消息`,
    url,
    {
      parts: parts.length,
      预览: clip(text, 200),
      ...(modelBody ? { model: modelBody } : {}),
      ...(agent ? { agent } : {}),
    },
    directory ? { directory } : '',
  )
  console.log(
    `${LOG.http} POST /message 已发出：下一条「${LOG.httpResp}」要等 OpenCode 结束本轮 HTTP 才会打印（期间 session 可能 busy，属正常；流式过程在 SSE）。`,
  )
  const res = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders({ 'Content-Type': 'application/json' }, directory),
    body: JSON.stringify(reqBody),
  })
  const bodyText = await res.text()
  console.log(`${LOG.httpResp} POST /message`, {
    url,
    status: res.status,
    ok: res.ok,
    bodyLength: bodyText.length,
    bodyPreview: bodyText.length ? clip(bodyText, 800) : '(empty body)',
  })
  if (!res.ok) throw new Error(`Failed to send message: ${res.status} ${bodyText}`)
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('text/html') || /^\s*</i.test(bodyText)) {
    throw new Error(
      `[OpenCode] POST /message 返回了 HTML 页面而不是 API JSON，通常是请求路径错误。正确路径应为 /session/<sessionId>/message（不要写成 /session}/）。当前 URL：${url}`,
    )
  }
}

/** 中止当前会话正在运行的本轮执行（OpenCode: POST /session/:id/abort） */
export async function abortSession(sessionId: string, directory?: string): Promise<void> {
  const url = `${BASE}/session/${sessionId}/abort`
  console.log(`${LOG.http} POST 中止会话执行`, url, directory ? { directory } : '')
  const res = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders({}, directory),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`abortSession failed: ${res.status} ${bodyText}`)
  }
}

/** 原生分叉会话（OpenCode: POST /session/:id/fork，可选 messageID 锚点） */
export async function forkSession(
  sessionId: string,
  options?: { messageID?: string; directory?: string }
): Promise<OcSession> {
  const url = `${BASE}/session/${sessionId}/fork`
  const body = options?.messageID ? { messageID: options.messageID } : {}
  console.log(
    `${LOG.http} POST 分叉会话`,
    url,
    options?.messageID ? { messageID: options.messageID } : {},
    options?.directory ? { directory: options.directory } : ''
  )
  const res = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders({ 'Content-Type': 'application/json' }, options?.directory),
    body: JSON.stringify(body),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`forkSession failed: ${res.status} ${bodyText}`)
  }
  const data = JSON.parse(bodyText) as OcSession
  return data
}

export async function getDiff(sessionId: string): Promise<any[]> {
  const res = await fetch(`${BASE}/session/${sessionId}/diff`, { headers: withDirectoryHeaders({}) })
  if (!res.ok) throw new Error(`Failed to fetch diff: ${res.status}`)
  return res.json()
}

/**
 * 回复 OpenCode `question` 工具（SDK v2：`POST /question/{requestID}/reply`，body: `{ answers }`）。
 * `answers` 与 `questions` 数组顺序一致；每题为所选 option 的 `label` 组成的数组。
 */
export async function replyToQuestion(
  requestId: string,
  answers: string[][],
  directory?: string,
): Promise<void> {
  const url = `${BASE}/question/${encodeURIComponent(requestId)}/reply`
  console.log(`${LOG.http} POST 回答问题`, url, { answersCount: answers.length }, directory ? { directory } : '')
  const res = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders({ 'Content-Type': 'application/json' }, directory),
    body: JSON.stringify({ answers }),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`replyToQuestion failed: ${res.status} ${bodyText}`)
  }
  console.log(`${LOG.http} POST /question/.../reply`, clip(bodyText, 200))
}

function normalizePendingQuestionList(raw: unknown): OcPendingQuestionItem[] {
  if (Array.isArray(raw)) return raw as OcPendingQuestionItem[]
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    for (const k of ['data', 'items', 'pending', 'result']) {
      const v = o[k]
      if (Array.isArray(v)) return v as OcPendingQuestionItem[]
    }
  }
  return []
}

/**
 * OpenCode：`GET /question`，列出待处理的 question 请求（用于根据 messageID/callID 解析 requestID）。
 * 部分版本会把数组包在 `{ data: [...] }` 里，此处统一解析。
 */
export async function getPendingQuestions(
  directory?: string,
  options?: { sessionID?: string },
): Promise<OcPendingQuestionItem[]> {
  const buildUrl = (includeSession: boolean) => {
    const params = new URLSearchParams()
    if (directory) params.set('directory', directory)
    if (includeSession && options?.sessionID) params.set('sessionID', options.sessionID)
    const qs = params.toString()
    return qs ? `${BASE}/question?${qs}` : `${BASE}/question`
  }

  const fetchList = async (url: string) => {
    const res = await fetch(url, { headers: withDirectoryHeaders({}, directory) })
    if (!res.ok) return { ok: false as const, status: res.status, text: await res.text() }
    const data = await res.json()
    return { ok: true as const, data }
  }

  let url = buildUrl(true)
  console.log(
    `${LOG.http} GET 待处理 question 列表`,
    url,
    directory ? { directory } : '',
    options?.sessionID ? { sessionID: options.sessionID } : '',
  )
  let result = await fetchList(url)
  if (
    !result.ok &&
    options?.sessionID &&
    (result.status === 400 || result.status === 404 || result.status === 422)
  ) {
    console.warn(`${LOG.http} GET /question 带 sessionID 失败 ${result.status}，改为不带 session 重试`)
    url = buildUrl(false)
    result = await fetchList(url)
  }
  if (!result.ok) {
    throw new Error(`getPendingQuestions failed: ${result.status} ${result.text}`)
  }
  const list = normalizePendingQuestionList(result.data)
  console.log(`${LOG.http} GET /question`, list.length, '条')
  return list
}

/** `POST /question/{requestID}/reject` */
export async function rejectQuestion(requestId: string, directory?: string): Promise<void> {
  const url = `${BASE}/question/${encodeURIComponent(requestId)}/reject`
  console.log(`${LOG.http} POST 拒绝回答问题`, url, directory ? { directory } : '')
  const res = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders({}, directory),
  })
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`rejectQuestion failed: ${res.status} ${bodyText}`)
  }
}

// ===== SSE (real-time events) =====

// 说明：
// - GET /global/event、GET /event 均为 text/event-stream。
// - OpenCode 常对每条 SSE 使用 **自定义 event: 名称**（如 message.part.updated）。
// - 浏览器原生 EventSource.onmessage **只会**收到未命名或 `event: message` 的包，
//   因此若服务端只发命名事件，你会「完全看不到」——这不是没监听，是 API 限制。
// - 下面用 fetch + 手动按行解析，可收到所有 event 名并打日志。

const SSE_RECONNECT_MS = 2500

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function sseReconnectWarn(label: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  console.warn(
    `${label} 流结束或出错，将重连`,
    msg,
    '（TypeError: network error 多为：OpenCode 未启动、VITE 代理/baseURL 不对、HTTPS 混用、或连接被服务端/网络断开）'
  )
}

/** 解析 SSE：空行触发一次 dispatch（event 名 + data 拼接） */
function createSseLineDispatcher(
  onDispatch: (eventName: string, data: string) => void
): (line: string) => void {
  let eventName = 'message'
  const dataLines: string[] = []

  return (line: string) => {
    const trimmed = line.replace(/\r$/, '')
    if (trimmed === '') {
      if (dataLines.length > 0) {
        const data = dataLines.join('\n')
        dataLines.length = 0
        const ev = eventName
        eventName = 'message'
        onDispatch(ev, data)
      } else {
        eventName = 'message'
      }
      return
    }
    if (trimmed.startsWith(':')) return
    if (trimmed.startsWith('event:')) {
      eventName = trimmed.slice(6).trim()
      return
    }
    if (trimmed.startsWith('data:')) {
      const rest = trimmed.slice(5)
      dataLines.push(rest.startsWith(' ') ? rest.slice(1) : rest)
    }
  }
}

async function streamGlobalSse(
  url: string,
  signal: AbortSignal,
  onEvent: (event: unknown) => void
): Promise<void> {
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...basicAuthHeader() },
    signal,
  })
  if (!res.ok) {
    throw new Error(`SSE HTTP ${res.status}`)
  }
  const body = res.body
  if (!body) throw new Error('SSE body null')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  const dispatchLine = createSseLineDispatcher((eventName, dataStr) => {
    console.log(
      '[OpenCode · SSE · event 类型名]',
      eventName,
      `${LOG.sseRaw}`,
      clip(dataStr, 2500)
    )
    try {
      const parsed = JSON.parse(dataStr) as Record<string, unknown>
      const t =
        (parsed?.payload as { type?: string } | undefined)?.type ??
        (parsed as { type?: string }).type
      console.log(`${LOG.sseParsed}`, { wireEvent: eventName, busType: t, 对象: parsed })
      onEvent(parsed)
    } catch {
      console.warn('[OpenCode · SSE] data 非 JSON', dataStr.slice(0, 500))
    }
  })

  while (!signal.aborted) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const line of parts) {
      dispatchLine(line)
    }
  }
}

/**
 * 订阅 GET /global/event（全局 SSE）。
 * 使用 fetch 流式解析，可收到带 `event:` 字段的包；App 里仍用 payload.type 做过滤。
 */
export function subscribeGlobalEvents(
  onEvent: (event: any) => void
): () => void {
  const url = `${BASE}/global/event`
  const ac = new AbortController()

  console.log(
    `${LOG.http} 即将建立 SSE（fetch 流解析，含自定义 event:）`,
    url,
    '完整对话 JSON 仍以 GET /message 为准'
  )

  ;(async function loop() {
    while (!ac.signal.aborted) {
      try {
        await streamGlobalSse(url, ac.signal, onEvent)
      } catch (e) {
        if (ac.signal.aborted) break
        sseReconnectWarn('[OpenCode · SSE]', e)
      }
      if (ac.signal.aborted) break
      await sleep(SSE_RECONNECT_MS)
    }
  })()

  return () => ac.abort()
}

/**
 * 可选：当前 workspace 的 GET /event（与 /global/event 二选一或并行调试用）。
 * 同样用手动解析，避免 EventSource 丢事件。
 */
export function subscribeWorkspaceEvents(onEvent: (event: any) => void): () => void {
  const url = `${BASE}/event`
  const ac = new AbortController()
  console.log(`${LOG.http} 即将建立 SSE（workspace）`, url)

  ;(async function loop() {
    while (!ac.signal.aborted) {
      try {
        await streamGlobalSse(url, ac.signal, onEvent)
      } catch (e) {
        if (ac.signal.aborted) break
        sseReconnectWarn('[OpenCode · SSE /event]', e)
      }
      if (ac.signal.aborted) break
      await sleep(SSE_RECONNECT_MS)
    }
  })()

  return () => ac.abort()
}
