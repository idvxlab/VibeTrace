import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** 浏览器端只能打进构建产物：合并两套命名，避免只配了 OPENCODE_BASE（worker）却忘了 VITE_。优先 VITE_OPENCODE_BASE。 */
function mergedOpencodeHttpBase(env: Record<string, string>): string {
  const raw =
    env.VITE_OPENCODE_BASE?.trim() ||
    env.OPENCODE_BASE?.trim() ||
    'http://127.0.0.1:4096'
  return raw.replace(/\/$/, '')
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const opencodeHttpBase = mergedOpencodeHttpBase(env)

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
    },
    define: {
      __OPENCODE_HTTP_BASE__: JSON.stringify(opencodeHttpBase),
    },
  }
})
