import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }

type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Errors are shown inline via render(); avoid console noise */
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
          <h1 style={{ fontSize: 18, marginBottom: 12 }}>VibeTrace failed to render</h1>
          <p style={{ color: '#444', marginBottom: 12 }}>
            Open Developer Tools (F12) → Console for the full stack trace. If this is related to OpenCode model
            configuration, check your server-side settings as well.
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
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
