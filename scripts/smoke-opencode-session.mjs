/**
 * 终端直连 OpenCode，验证 POST /session 是否可用（不经过浏览器）。
 *
 * 用法：
 *   npm run smoke:opencode
 *   set OPENCODE_DIRECTORY=D:\path\to\project && npm run smoke:opencode
 *   set OPENCODE_BASE=http://127.0.0.1:4096 && npm run smoke:opencode
 */

const BASE = process.env.OPENCODE_BASE || 'http://127.0.0.1:4096'
const DIRECTORY = process.env.OPENCODE_DIRECTORY

async function main() {
  console.log(`OpenCode base: ${BASE}`)
  if (DIRECTORY) console.log(`x-opencode-directory: ${DIRECTORY}`)

  console.log('\n--- 1) GET /global/health（确认服务在跑）---')
  const healthRes = await fetch(`${BASE}/global/health`)
  const healthText = await healthRes.text()
  console.log('status:', healthRes.status)
  console.log('body:', healthText.slice(0, 500))

  console.log('\n--- 1b) GET /config（看当前 model / small_model，排查 ProviderModelNotFound）---')
  const cfgRes = await fetch(`${BASE}/config`)
  const cfgText = await cfgRes.text()
  console.log('status:', cfgRes.status)
  try {
    const c = JSON.parse(cfgText)
    console.log('  model:', c.model ?? '(无)')
    console.log('  small_model:', c.small_model ?? '(无)')
  } catch {
    console.log('  (非 JSON)', cfgText.slice(0, 400))
  }

  console.log('\n--- 2) POST /session（官方文档：返回 Session JSON）---')
  const headers = { 'Content-Type': 'application/json' }
  if (DIRECTORY) headers['x-opencode-directory'] = DIRECTORY

  const res = await fetch(`${BASE}/session`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })
  const text = await res.text()
  console.log('status:', res.status)
  console.log('content-type:', res.headers.get('content-type'))
  console.log('body length (bytes):', Buffer.byteLength(text, 'utf8'))
  console.log('body preview:\n', text.slice(0, 800))

  if (res.status === 200 && text.trim().startsWith('<')) {
    console.error(
      '\n[错误] 返回了 HTML，说明 URL 可能打到了网页而不是 API（例如端口上是别的服务、或路径写错）。',
    )
    process.exitCode = 1
    return
  }

  if (text.trim()) {
    try {
      const j = JSON.parse(text)
      console.log('\n[解析成功] Session 字段示例:')
      console.log('  id:', j.id)
      console.log('  directory:', j.directory)
      console.log('  title:', j.title)
    } catch (e) {
      console.error('\n[错误] 200 但 body 不是合法 JSON:', e.message)
      process.exitCode = 1
    }
  } else {
    console.warn(
      '\n[提示] body 为空。部分版本在带 x-opencode-directory 时会这样；可再 GET /session 列表核对是否已创建。',
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
