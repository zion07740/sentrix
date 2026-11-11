import { useCallback, useEffect, useState } from 'react'
import type { AppState, PairRequest } from '@shared/types'
import { ToastProvider } from './components/ui'
import { SetupScreen, UnlockScreen } from './screens/Auth'
import { VaultScreen } from './screens/Vault'
import { PairModal } from './screens/PairModal'

const api = window.sentrix

export default function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [pair, setPair] = useState<PairRequest | null>(null)

  const refresh = useCallback(() => api.app.state().then(setState), [])

  useEffect(() => {
    refresh()
    const offLock = api.on('locked', refresh)
    const offPair = api.onPairRequest(setPair)
    return () => {
      offLock()
      offPair()
    }
  }, [refresh])

  // Tell the main process the user is active (postpones auto-lock), at most every 15 s.
  useEffect(() => {
    let last = 0
    const ping = () => {
      const now = Date.now()
      if (now - last > 15_000) {
        last = now
        api.app.activity().catch(() => undefined)
      }
    }
    window.addEventListener('keydown', ping)
    window.addEventListener('mousedown', ping)
    window.addEventListener('wheel', ping, { passive: true })
    return () => {
      window.removeEventListener('keydown', ping)
      window.removeEventListener('mousedown', ping)
      window.removeEventListener('wheel', ping)
    }
  }, [])

  // Clear the pairing prompt when the vault locks.
  useEffect(() => {
    if (state && !state.unlocked) setPair(null)
  }, [state])

  return (
    <ToastProvider>
      {!state ? (
        <div className="splash" />
      ) : !state.vaultExists ? (
        <SetupScreen onDone={refresh} />
      ) : !state.unlocked ? (
        <UnlockScreen onDone={refresh} />
      ) : (
        <VaultScreen onLock={() => api.vault.lock().then(refresh)} />
      )}
      {pair && state?.unlocked && <PairModal request={pair} onClose={() => setPair(null)} />}
    </ToastProvider>
  )
}
