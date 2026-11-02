import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import 'react-tooltip/dist/react-tooltip.css'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'

const el = document.getElementById('root')
if (!el) {
  throw new Error('#root element missing — check index.html')
}

createRoot(el).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
