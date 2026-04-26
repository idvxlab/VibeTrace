import { useState } from 'react'

interface ReasoningBlockProps {
  text: string
  time?: { start: number; end: number }
}

export default function ReasoningBlock({ text, time }: ReasoningBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const duration = time ? ((time.end - time.start) / 1000).toFixed(1) : null

  // Truncate preview
  const preview = text.length > 80 ? text.slice(0, 80) + '...' : text

  return (
    <div
      style={{
        background: '#FAFAFA',
        borderRadius: 6,
        overflow: 'hidden',
        maxWidth: '100%',
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {/* Thinking icon */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#8445BC"
          strokeWidth="2"
        >
          <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.548.547A3.374 3.374 0 0 0 14 18.469V19a2 2 0 1 1-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>

        <span style={{ fontSize: 11, fontWeight: 500, color: '#8445BC' }}>
          Thinking
        </span>

        {duration && (
          <span style={{ fontSize: 10, color: '#8F8F8F', fontFamily: 'IBM Plex Mono, monospace' }}>
            {duration}s
          </span>
        )}

        <span
          style={{
            flex: 1,
            fontSize: 11,
            color: '#8F8F8F',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginLeft: 4,
          }}
        >
          {preview}
        </span>

        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#8F8F8F"
          strokeWidth="2"
          style={{
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.15s ease',
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div
          style={{
            borderTop: '1px solid #E8E8E8',
            padding: '8px 10px',
          }}
        >
          <pre
            style={{
              fontFamily: 'Inter, sans-serif',
              fontSize: 12,
              lineHeight: 1.5,
              color: '#6F6F6F',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
            }}
          >
            {text}
          </pre>
        </div>
      )}
    </div>
  )
}
