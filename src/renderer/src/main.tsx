import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/** If the UI crashes, lock the vault and offer a reload instead of leaving a blank window. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error:', error.message, info.componentStack)
    window.sentrix.vault.lock().catch(() => undefined)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="auth">
        <div className="auth-card">
          <h1>Something went wrong</h1>
          <p className="muted">Sentrix locked itself to keep your vault safe. Your data is not affected.</p>
          <button className="btn primary block" onClick={() => location.reload()}>
            Reload Sentrix
          </button>
        </div>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
