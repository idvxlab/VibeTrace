import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SHOW_COMPOSER_MODEL_UI } from '../config/featureFlags'
import type { OcComposerModelOption } from '../services/opencodeApi'
import { prepareOutgoingFromFiles } from '../utils/messageAttachments'

export type MessageSendPayload = {
  combinedText: string
  imageParts: Array<{ media_type: string; data: string }>
}

interface MessageInputProps {
  onSend: (payload: MessageSendPayload) => Promise<void>
  onAbort?: () => Promise<void>
  disabled?: boolean
  isRunning?: boolean
  aborting?: boolean
  sessionId?: string
  agentName?: string | null
  modelName?: string | null
  /** `provider/model`; empty string → omit body.model (then `.env` default inside API layer may still apply). */
  composerModelRef?: string
  onComposerModelRefChange?: (ref: string) => void
  composerModelOptions?: OcComposerModelOption[]
  composerModelsLoading?: boolean
  composerModelsError?: string | null
  /** Shown when composer selection is empty — mirrors `VITE_OPENCODE_DEFAULT_MODEL`. */
  envBootstrapModel?: string | null
}

const FONT_SIZE = 12
const LINE_HEIGHT = 1.5
const LINE_PX = FONT_SIZE * LINE_HEIGHT
const MIN_ROWS = 2
const MAX_ROWS = 6
const MIN_H = MIN_ROWS * LINE_PX
const MAX_H = MAX_ROWS * LINE_PX

export default function MessageInput({
  onSend,
  onAbort,
  disabled,
  isRunning,
  aborting,
  agentName,
  modelName,
  composerModelRef = '',
  onComposerModelRefChange,
  composerModelOptions = [],
  composerModelsLoading = false,
  composerModelsError = null,
  envBootstrapModel = null,
}: MessageInputProps) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(Math.max(el.scrollHeight, MIN_H), MAX_H)
    el.style.height = `${next}px`
  }, [text])

  const canSend =
    (text.trim().length > 0 || files.length > 0) && !sending && !disabled
  const canAbort = Boolean(isRunning && onAbort && !aborting && !disabled)

  const nextSendModelHint = useMemo(() => {
    if (!SHOW_COMPOSER_MODEL_UI) return ''
    const picked = composerModelRef.trim()
    if (picked) return picked
    const env = (envBootstrapModel && envBootstrapModel.trim()) || ''
    if (env) return `${env}（VITE_OPENCODE_DEFAULT_MODEL）`
    return 'OpenCode 服务端默认'
  }, [composerModelRef, envBootstrapModel])

  const handleSend = async () => {
    if (!canSend) return
    const prevText = text
    const prevFiles = files
    // Clear immediately so long requests don’t leave stale text in the composer
    setText('')
    setFiles([])
    setSending(true)
    setAttachError(null)
    try {
      const { combinedText, images } = await prepareOutgoingFromFiles(prevFiles, prevText)
      await onSend({ combinedText, imageParts: images })
    } catch (err) {
      // Restore draft on failure
      setText(prevText)
      setFiles(prevFiles)
      const msg = err instanceof Error ? err.message : String(err)
      setAttachError(msg)
    } finally {
      setSending(false)
    }
  }

  const handleAbort = async () => {
    if (!canAbort || !onAbort) return
    try {
      await onAbort()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setAttachError(msg)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const onPickFiles = () => {
    setAttachError(null)
    fileInputRef.current?.click()
  }

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files
    if (!list?.length) return
    setFiles((prev) => [...prev, ...Array.from(list)])
    e.target.value = ''
  }

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <div style={{ padding: '10px 16px' }}>
      {SHOW_COMPOSER_MODEL_UI && (
        <div
          style={{
            marginBottom: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label htmlFor="openscope-composer-model" style={{ fontSize: 11, color: '#666', flexShrink: 0 }}>
              模型
            </label>
            <select
              id="openscope-composer-model"
              value={composerModelRef.trim() ? composerModelRef.trim() : ''}
              onChange={(e) => onComposerModelRefChange?.(e.target.value)}
              disabled={disabled || !onComposerModelRefChange || composerModelsLoading}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 11,
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid #E8E8E8',
                background: '#FFFFFF',
                color: '#333',
              }}
            >
              <option value="">默认（不在请求里指定 model）</option>
              {composerModelOptions.map((o) => (
                <option key={o.ref} value={o.ref}>
                  {o.label}
                </option>
              ))}
            </select>
            {composerModelsLoading && (
              <span style={{ fontSize: 10, color: '#999', flexShrink: 0 }}>加载中…</span>
            )}
          </div>
          {composerModelsError && (
            <div style={{ fontSize: 10, color: '#C62828', lineHeight: 1.4 }}>
              无法拉取模型列表（需要 OpenCode 暴露 GET /config/providers）：{composerModelsError}
            </div>
          )}
          <div style={{ fontSize: 10, color: '#888', lineHeight: 1.4 }}>
            下一条消息将使用：<span style={{ color: '#555' }}>{nextSendModelHint}</span>
          </div>
        </div>
      )}

      <div
        style={{
          background: '#FFFFFF',
          border: '1px solid #E8E8E8',
          borderRadius: '8px',
          overflow: 'hidden',
        }}
      >
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask something…"
          disabled={disabled || sending}
          rows={MIN_ROWS}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            minHeight: MIN_H,
            maxHeight: MAX_H,
            overflowY: 'auto',
            padding: '10px 12px',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            color: '#333',
            fontSize: FONT_SIZE,
            lineHeight: LINE_HEIGHT,
            fontFamily: 'inherit',
          }}
        />

        {files.length > 0 && (
          <div
            style={{
              padding: '4px 10px 6px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              borderTop: '1px solid #F0F0F0',
            }}
          >
            {files.map((f, i) => (
              <span
                key={`${f.name}-${i}-${f.size}`}
                style={{
                  fontSize: 11,
                  color: '#555',
                  background: '#F5F5F5',
                  borderRadius: 4,
                  padding: '2px 8px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  maxWidth: '100%',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.name}
                </span>
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: 14,
                    lineHeight: 1,
                    color: '#999',
                  }}
                  aria-label="Remove attachment"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '8px 10px',
            borderTop: '1px solid #F0F0F0',
            background: '#FAFAFA',
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            accept="image/*,.txt,.md,.json,.jsonc,.csv,.ts,.tsx,.js,.jsx,.css,.html,.xml,.yaml,.yml,.log,.env,.rs,.go,.py,.vue"
            onChange={onFileInputChange}
          />
          <button
            type="button"
            onClick={onPickFiles}
            disabled={disabled || sending}
            title="Attach images or text files"
            style={{
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#FFFFFF',
              border: '1px solid #E8E8E8',
              borderRadius: 6,
              cursor: disabled || sending ? 'not-allowed' : 'pointer',
              opacity: disabled || sending ? 0.5 : 1,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>

          <button
            type="button"
            onClick={() => void (canAbort ? handleAbort() : handleSend())}
            disabled={canAbort ? false : !canSend}
            style={{
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: canAbort ? '#FFECEC' : (canSend ? '#8B5CF6' : '#F5F5F5'),
              border: 'none',
              borderRadius: 6,
              cursor: canAbort || canSend ? 'pointer' : 'not-allowed',
              opacity: sending ? 0.7 : 1,
            }}
          >
            {canAbort ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#D94A4A" strokeWidth="2">
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={canSend ? 'white' : '#CCC'} strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {attachError && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#C62828' }}>{attachError}</div>
      )}

      {(agentName || modelName) && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: '#999',
            display: 'flex',
            gap: 12,
          }}
        >
          {agentName && <span>{agentName}</span>}
          {modelName && <span>{modelName}</span>}
        </div>
      )}
    </div>
  )
}
