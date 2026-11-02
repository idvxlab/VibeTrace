/**
 * Connect directly to OpenCode from the terminal and verify POST /session.
 *
 * Usage:
 *   npm run smoke:opencode
 *   set OPENCODE_DIRECTORY=D:\path\to\project && npm run smoke:opencode
 *   set OPENCODE_BASE=http://127.0.0.1:4096 && npm run smoke:opencode
 */

const BASE = process.env.OPENCODE_BASE || 'http://127.0.0.1:4096'
const DIRECTORY = process.env.OPENCODE_DIRECTORY

async function main() {
  console.log(`OpenCode base: ${BASE}`)
  if (DIRECTORY) console.log(`x-opencode-directory: ${DIRECTORY}`)

  console.log('\n--- 1) GET /global/health (check service health) ---')
  const healthRes = await fetch(`${BASE}/global/health`)
  const healthText = await healthRes.text()
  console.log('status:', healthRes.status)
  console.log('body:', healthText.slice(0, 500))

  console.log('\n--- 1b) GET /config (inspect model / small_model) ---')
  const cfgRes = await fetch(`${BASE}/config`)
  const cfgText = await cfgRes.text()
  console.log('status:', cfgRes.status)
  try {
    const c = JSON.parse(cfgText)
    console.log('  model:', c.model ?? '(none)')
    console.log('  small_model:', c.small_model ?? '(none)')
  } catch {
    console.log('  (non-JSON)', cfgText.slice(0, 400))
  }

  console.log('\n--- 2) POST /session (expect Session JSON) ---')
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
      '\n[ERROR] Received HTML instead of an API response. Check the service port and URL path.',
    )
    process.exitCode = 1
    return
  }

  if (text.trim()) {
    try {
      const j = JSON.parse(text)
      console.log('\n[OK] Parsed Session fields:')
      console.log('  id:', j.id)
      console.log('  directory:', j.directory)
      console.log('  title:', j.title)
    } catch (e) {
      console.error('\n[ERROR] Response body is not valid JSON:', e.message)
      process.exitCode = 1
    }
  } else {
    console.warn(
      '\n[NOTE] Empty response body. Some versions do this with x-opencode-directory; use GET /session to check whether the session was created.',
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
