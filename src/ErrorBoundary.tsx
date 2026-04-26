import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }

type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[cockpit-ui] ErrorBoundary', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            fontFamily: 'Inter, system-ui, sans-serif',
            maxWidth: 720,
            lineHeight: 1.5,
          }}
        >
          <h1 style={{ fontSize: 18, marginBottom: 12 }}>cockpit-ui 渲染出错</h1>
          <p style={{ color: '#444', marginBottom: 12 }}>
            请打开开发者工具 (F12) → Console 查看完整堆栈。若为 OpenCode 模型配置问题，请见下方说明。
          </p>
          <pre
            style={{
              background: '#f5f5f5',
              padding: 12,
              borderRadius: 8,
              overflow: 'auto',
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 16,
              padding: '8px 14px',
              cursor: 'pointer',
              borderRadius: 6,
              border: '1px solid #ccc',
              background: '#fff',
            }}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
