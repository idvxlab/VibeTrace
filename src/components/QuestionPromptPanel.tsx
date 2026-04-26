import { useState, useEffect } from 'react'
import type { OcPendingQuestionRequest, OcQuestionInfo } from '../types/opencode'

interface QuestionPromptPanelProps {
  request: OcPendingQuestionRequest
  disabled?: boolean
  submitting?: boolean
  onReply: (answers: string[][]) => Promise<void>
  onReject?: () => Promise<void>
}

/**
 * OpenCode `question` 工具：按 SSE `question.asked` 中的题目渲染选项，提交格式与
 * `POST /question/{requestID}/reply` 的 `answers` 一致（每题为所选 option 的 label 数组）。
 */
export default function QuestionPromptPanel({
  request,
  disabled,
  submitting,
  onReply,
  onReject,
}: QuestionPromptPanelProps) {
  const { questions, id } = request
  /** 每题已选 label 列表 */
  const [selections, setSelections] = useState<string[][]>(() => questions.map(() => []))
  /** 每题自定义补充（custom 允许时） */
  const [customTexts, setCustomTexts] = useState<string[]>(() => questions.map(() => ''))

  useEffect(() => {
    setSelections(questions.map(() => []))
    setCustomTexts(questions.map(() => ''))
  }, [id, questions])

  const setQuestionSelection = (qi: number, labels: string[]) => {
    setSelections((prev) => {
      const next = [...prev]
      next[qi] = labels
      return next
    })
  }

  const toggleOption = (q: OcQuestionInfo, qi: number, label: string) => {
    const cur = selections[qi] ?? []
    if (q.multiple) {
      const has = cur.includes(label)
      setQuestionSelection(qi, has ? cur.filter((l) => l !== label) : [...cur, label])
    } else {
      setQuestionSelection(qi, [label])
    }
  }

  const buildAnswers = (): string[][] | null => {
    const out: string[][] = []
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi]!
      const selected = [...(selections[qi] ?? [])]
      const extra = (customTexts[qi] ?? '').trim()
      const allowCustom = q.custom !== false
      if (selected.length > 0) {
        out.push(selected)
      } else if (extra && allowCustom) {
        out.push([extra])
      } else {
        return null
      }
    }
    return out
  }

  const submit = async () => {
    const answers = buildAnswers()
    if (!answers) {
      window.alert('请为每道题至少选择一项，或在自定义栏填写答案。')
      return
    }
    await onReply(answers)
  }

  return (
    <div
      style={{
        borderTop: '1px solid #E8E8E8',
        background: 'linear-gradient(180deg, #FAF7FF 0%, #FFFFFF 100%)',
        padding: '12px 16px',
        flexShrink: 0,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: '#4A2D7C', marginBottom: 10 }}>
        需要你的选择（agent 提问）
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {questions.map((q, qi) => (
          <div
            key={`${id}-q-${qi}`}
            style={{
              border: '1px solid #E8E8E8',
              borderRadius: 8,
              padding: '10px 12px',
              background: '#FFFFFF',
            }}
          >
            {q.header ? (
              <div style={{ fontSize: 11, color: '#8445BC', marginBottom: 4 }}>{q.header}</div>
            ) : null}
            <div style={{ fontSize: 12, color: '#333', lineHeight: 1.5, marginBottom: 8 }}>{q.question}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {q.options.map((opt) => {
                const sel = selections[qi] ?? []
                const checked = q.multiple ? sel.includes(opt.label) : sel[0] === opt.label
                return (
                  <label
                    key={opt.label}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      cursor: disabled || submitting ? 'not-allowed' : 'pointer',
                      fontSize: 11,
                      color: '#444',
                    }}
                  >
                    <input
                      type={q.multiple ? 'checkbox' : 'radio'}
                      name={`q-${id}-${qi}`}
                      checked={checked}
                      disabled={disabled || submitting}
                      onChange={() => toggleOption(q, qi, opt.label)}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      <span style={{ fontWeight: 500 }}>{opt.label}</span>
                      {opt.description ? (
                        <span style={{ color: '#888', display: 'block', marginTop: 2 }}>{opt.description}</span>
                      ) : null}
                    </span>
                  </label>
                )
              })}
            </div>
            {q.custom !== false && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 10, color: '#999', marginBottom: 4 }}>补充说明（可选）</div>
                <input
                  type="text"
                  value={customTexts[qi] ?? ''}
                  disabled={disabled || submitting}
                  onChange={(e) => {
                    const v = e.target.value
                    setCustomTexts((prev) => {
                      const next = [...prev]
                      next[qi] = v
                      return next
                    })
                  }}
                  placeholder="若有额外说明可写在这里，会一并提交"
                  style={{
                    width: '100%',
                    fontSize: 11,
                    padding: '6px 8px',
                    border: '1px solid #E0E0E0',
                    borderRadius: 6,
                    fontFamily: 'inherit',
                  }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        {onReject && (
          <button
            type="button"
            disabled={disabled || submitting}
            onClick={() => void onReject()}
            style={{
              fontSize: 11,
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #E0E0E0',
              background: '#FFF',
              color: '#666',
              cursor: disabled || submitting ? 'not-allowed' : 'pointer',
            }}
          >
            跳过
          </button>
        )}
        <button
          type="button"
          disabled={disabled || submitting}
          onClick={() => void submit()}
          style={{
            fontSize: 11,
            padding: '6px 16px',
            borderRadius: 6,
            border: 'none',
            background: submitting ? '#C4B5D8' : '#8445BC',
            color: '#FFF',
            cursor: disabled || submitting ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting ? '提交中…' : '提交答案'}
        </button>
      </div>
    </div>
  )
}
