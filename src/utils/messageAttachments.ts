/** 从本地文件准备发往 OpenCode 的附件（图片 base64 + 文本类文件内容） */

const MAX_TEXT_FILE_CHARS = 400_000
const MAX_IMAGE_BYTES = 12 * 1024 * 1024

const TEXT_LIKE_EXT = new Set([
  'txt',
  'md',
  'json',
  'jsonc',
  'csv',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'css',
  'html',
  'htm',
  'xml',
  'yaml',
  'yml',
  'log',
  'env',
  'sh',
  'ps1',
  'bat',
  'cmd',
  'rs',
  'go',
  'py',
  'java',
  'kt',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'vue',
  'svelte',
])

export type PreparedImagePart = { media_type: string; data: string }

export type PreparedOutgoing = {
  /** 与输入框、文本附件合并后的「用户原文」（尚未套 harness 引导） */
  combinedText: string
  images: PreparedImagePart[]
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function isProbablyTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (file.type === 'application/json' || file.type === 'application/xml') return true
  return TEXT_LIKE_EXT.has(extOf(file.name))
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`图片过大（>${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB）：${file.name}`))
      return
    }
    const r = new FileReader()
    r.onload = () => {
      const s = r.result as string
      const b64 = s.includes(',') ? s.split(',')[1]! : s
      resolve(b64)
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

function readFileAsTextLimited(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      let t = r.result as string
      if (t.length > MAX_TEXT_FILE_CHARS) {
        t = `${t.slice(0, MAX_TEXT_FILE_CHARS)}\n\n…（已截断，文件过长）`
      }
      resolve(t)
    }
    r.onerror = () => reject(r.error)
    r.readAsText(file)
  })
}

/**
 * 将用户选择的文件转为图片 parts + 与输入框文案合并后的正文。
 * 仅支持：常见图片 MIME；可识别的文本类扩展名。
 */
export async function prepareOutgoingFromFiles(
  files: File[],
  userText: string,
): Promise<PreparedOutgoing> {
  const images: PreparedImagePart[] = []
  const textBlocks: { name: string; content: string }[] = []

  for (const f of files) {
    if (f.type.startsWith('image/')) {
      const data = await readFileAsBase64(f)
      images.push({
        media_type: f.type || 'image/png',
        data,
      })
      continue
    }
    if (isProbablyTextFile(f)) {
      const content = await readFileAsTextLimited(f)
      textBlocks.push({ name: f.name, content })
      continue
    }
    throw new Error(`暂不支持的文件：${f.name}（请使用图片或常见源码/文本格式）`)
  }

  let combined = userText.trim()
  if (textBlocks.length > 0) {
    const blocks = textBlocks.map((t) => `【${t.name}】\n${t.content}`).join('\n\n---\n\n')
    combined = combined ? `${blocks}\n\n---\n\n${combined}` : blocks
  }
  if (!combined && images.length > 0) {
    combined = '请根据附件回答。'
  }

  return { combinedText: combined, images }
}
