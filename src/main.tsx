import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import 'react-tooltip/dist/react-tooltip.css'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'

const el = document.getElementById('root')
if (!el) {
  throw new Error('找不到 #root，请检查 index.html')
}

createRoot(el).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
