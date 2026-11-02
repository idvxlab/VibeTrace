/** Prepare attachments from local files for OpenCode (image base64 + text file contents) */

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
  /** Merged user text from input and text attachments (before harness guidance) */
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
      reject(new Error(`Image too large (>${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB): ${file.name}`))
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
        t = `${t.slice(0, MAX_TEXT_FILE_CHARS)}\n\n… (truncated — file too long)`
      }
      resolve(t)
    }
    r.onerror = () => reject(r.error)
    r.readAsText(file)
  })
}

/**
 * Convert user-selected files into image parts plus body text merged with the input field.
 * Supported: common image MIME types; recognizable text file extensions.
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
    throw new Error(`Unsupported file: ${f.name} (use images or common source/text formats)`)
  }

  let combined = userText.trim()
  if (textBlocks.length > 0) {
    const blocks = textBlocks.map((t) => `【${t.name}】\n${t.content}`).join('\n\n---\n\n')
    combined = combined ? `${blocks}\n\n---\n\n${combined}` : blocks
  }
  if (!combined && images.length > 0) {
    combined = 'Please respond based on the attachments.'
  }

  return { combinedText: combined, images }
}
