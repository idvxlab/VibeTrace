import type { OcTodo } from '../types/opencode'

interface FixedTodoPanelProps {
  todos: OcTodo[]
  loading?: boolean
  onTodoClick?: (todo: OcTodo) => void
}

const statusConfig = {
  pending: {
    label: '待处理',
    color: 'var(--text-weaker)',
    bg: 'var(--surface-weak)',
    border: 'var(--border-weak-base)',
  },
  in_progress: {
    label: '进行中',
    color: 'var(--color-accent)',
    bg: 'rgba(3, 76, 255, 0.08)',
    border: 'rgba(3, 76, 255, 0.3)',
  },
  completed: {
    label: '已完成',
    color: 'var(--color-success)',
    bg: 'rgba(18, 201, 5, 0.08)',
    border: 'rgba(18, 201, 5, 0.3)',
  },
}

const priorityConfig = {
  high: {
    label: '高',
    color: 'var(--color-error)',
    dot: '#fc533a',
  },
  medium: {
    label: '中',
    color: 'var(--color-warning)',
    dot: '#ffdc17',
  },
  low: {
    label: '低',
    color: 'var(--text-weaker)',
    dot: '#999999',
  },
}

export default function FixedTodoPanel({ todos, loading, onTodoClick }: FixedTodoPanelProps) {
  const pending = todos.filter(t => t.status !== 'completed')
  const completed = todos.filter(t => t.status === 'completed')

  if (loading) {
    return (
      <div
        className="shrink-0 flex items-center justify-center"
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border-weak-base)',
          background: 'var(--surface-base)',
        }}
      >
        <div className="flex items-center gap-2" style={{ color: 'var(--text-weaker)', fontSize: 12 }}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="animate-spin"
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          加载任务...
        </div>
      </div>
    )
  }

  if (todos.length === 0) {
    return (
      <div
        className="shrink-0"
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border-weak-base)',
          background: 'var(--surface-base)',
        }}
      >
        <div className="flex items-center gap-2" style={{ color: 'var(--text-weaker)', fontSize: 12 }}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          暂无任务 · 等待 agent 生成...
        </div>
      </div>
    )
  }

  return (
    <div
      className="shrink-0"
      style={{
        borderBottom: '1px solid var(--border-weak-base)',
        background: 'var(--surface-base)',
        maxHeight: 200,
        overflow: 'auto',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{
          borderBottom: '1px solid var(--border-weak-base)',
          background: 'var(--surface-raised-stronger)',
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        <div className="flex items-center gap-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            style={{ color: 'var(--text-interactive-base)' }}
          >
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-strong)' }}>
            任务列表
          </span>
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--text-weaker)',
              padding: '1px 6px',
              background: 'var(--surface-weak)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {pending.length} 进行中
          </span>
        </div>
        {completed.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-weaker)' }}>
            {completed.length} 已完成
          </span>
        )}
      </div>

      {/* Todo List */}
      <div className="p-2">
        {pending.map((todo, index) => {
          const status = statusConfig[todo.status]
          const priority = priorityConfig[todo.priority]

          return (
            <div
              key={index}
              onClick={() => onTodoClick?.(todo)}
              className="flex items-center gap-3 p-2 rounded-lg mb-1 cursor-pointer transition-colors"
              style={{
                background: 'var(--surface-raised-stronger)',
                border: `1px solid ${status.border}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--surface-raised-base-hover)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--surface-raised-stronger)'
              }}
            >
              {/* Checkbox */}
              <div
                className="shrink-0 flex items-center justify-center rounded"
                style={{
                  width: 16,
                  height: 16,
                  border: `2px solid ${status.color}`,
                  background: todo.status === 'completed' ? status.color : 'transparent',
                }}
              >
                {todo.status === 'completed' && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div
                  className="text-sm"
                  style={{
                    color: todo.status === 'completed' ? 'var(--text-weaker)' : 'var(--text-base)',
                    textDecoration: todo.status === 'completed' ? 'line-through' : 'none',
                  }}
                >
                  {todo.content}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  {/* Priority */}
                  <span
                    className="flex items-center gap-1"
                    style={{ fontSize: 10, color: priority.color }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: priority.dot,
                      }}
                    />
                    {priority.label}
                  </span>
                  {/* Status */}
                  <span
                    style={{
                      fontSize: 10,
                      color: status.color,
                      padding: '1px 4px',
                      background: status.bg,
                      borderRadius: 'var(--radius-sm)',
                    }}
                  >
                    {status.label}
                  </span>
                </div>
              </div>
            </div>
          )
        })}

        {/* Completed Section */}
        {completed.length > 0 && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-weak-base)' }}>
            <div
              className="flex items-center gap-2 mb-2 px-1"
              style={{ fontSize: 11, color: 'var(--text-weaker)' }}
            >
              <span>已完成</span>
              <span className="mono">({completed.length})</span>
            </div>
            {completed.slice(0, 3).map((todo, index) => (
              <div
                key={index}
                className="flex items-center gap-3 p-2 rounded-lg mb-1 opacity-60"
                style={{
                  background: 'var(--surface-raised-stronger)',
                  border: '1px solid var(--border-weak-base)',
                }}
              >
                <div
                  className="shrink-0 flex items-center justify-center rounded"
                  style={{
                    width: 16,
                    height: 16,
                    background: 'var(--color-success)',
                    border: '2px solid var(--color-success)',
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <div
                  className="flex-1 text-sm"
                  style={{
                    color: 'var(--text-weaker)',
                    textDecoration: 'line-through',
                  }}
                >
                  {todo.content}
                </div>
              </div>
            ))}
            {completed.length > 3 && (
              <div style={{ fontSize: 11, color: 'var(--text-weaker)', textAlign: 'center', padding: '4px' }}>
                还有 {completed.length - 3} 项已完成
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
