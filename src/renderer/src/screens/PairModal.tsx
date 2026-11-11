import { useState } from 'react'
import type { PairRequest } from '@shared/types'
import { Icon } from '../components/Icon'
import { Modal, useToast } from '../components/ui'

const api = window.sentrix

export function PairModal({ request, onClose }: { request: PairRequest; onClose: () => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const toast = useToast()

  const deny = async () => {
    await api.browser.deny(request.clientId)
    onClose()
  }

  const approve = async () => {
    const res = await api.browser.approve(request.clientId, code)
    if (res.ok) {
      toast(`${request.name} connected`)
      onClose()
    } else {
      setError(res.error ?? 'Pairing failed')
      if (/cancelled|expired/i.test(res.error ?? '')) setTimeout(onClose, 2500)
    }
  }

  return (
    <Modal title="Connect a browser?" onClose={deny}>
      <div className="pair">
        <Icon name="browser" size={36} />
        <p>
          <strong>{request.name}</strong> wants to use Sentrix to fill passwords.
        </p>
      </div>
      <p className="muted small">
        If you just clicked <em>Connect</em> in the Sentrix browser extension, type the 6-digit code it shows. If you didn't, click
        <em> Deny</em>.
      </p>
      <input
        className="code-input mono"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="000000"
        inputMode="numeric"
        autoFocus
        onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && approve()}
      />
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={deny}>
          Deny
        </button>
        <button className="btn primary" disabled={code.length !== 6} onClick={approve}>
          Connect
        </button>
      </div>
    </Modal>
  )
}
