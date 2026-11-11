import { useEffect, useState } from 'react'
import { Icon, Logo } from '../components/Icon'
import { PasswordInput, StrengthMeter } from '../components/ui'
import { strength } from '@shared/strength'

const api = window.sentrix

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const score = pw ? strength(pw).score : 0
  const problems: string[] = []
  if (pw.length < 8) problems.push('Use at least 8 characters (a passphrase of 4+ words is best)')
  else if (score < 3) problems.push('Pick something harder to guess')
  if (confirm && confirm !== pw) problems.push('Passwords do not match')
  const canSubmit = pw.length >= 8 && score >= 3 && pw === confirm && understood && !busy

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    const res = await api.vault.create(pw)
    setBusy(false)
    if (res.ok) onDone()
    else setError(res.error ?? 'Could not create the vault')
  }

  return (
    <div className="auth">
      <div className="auth-card wide">
        <div className="auth-brand">
          <Logo size={44} />
          <div>
            <h1>Welcome to Sentrix</h1>
            <p className="muted">Your passwords, encrypted and kept only on this computer.</p>
          </div>
        </div>

        <label className="field">
          <span>Create a master password</span>
          <PasswordInput value={pw} onChange={setPw} autoFocus placeholder="e.g. four random words you can remember" />
        </label>
        <StrengthMeter password={pw} />

        <label className="field">
          <span>Confirm master password</span>
          <PasswordInput value={confirm} onChange={setConfirm} onEnter={submit} />
        </label>

        {(pw || confirm) && problems.length > 0 && (
          <ul className="hints">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        <div className="callout warn">
          <strong>There is no "forgot password".</strong> Sentrix has no servers and nobody — not even the people who made it —
          can recover your vault without this password. Write it down and keep it somewhere safe.
        </div>
        <label className="check">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          <span>I understand that if I forget my master password, my data cannot be recovered.</span>
        </label>

        {error && <div className="error">{error}</div>}
        <button className="btn primary block" disabled={!canSubmit} onClick={submit}>
          {busy ? 'Creating encrypted vault…' : 'Create vault'}
        </button>
      </div>
    </div>
  )
}

export function UnlockScreen({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [waitUntil, setWaitUntil] = useState(0)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (waitUntil <= Date.now()) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [waitUntil])

  const waiting = Math.max(0, Math.ceil((waitUntil - now) / 1000))
  const [helloOn, setHelloOn] = useState(false)
  const [helloBusy, setHelloBusy] = useState(false)

  useEffect(() => {
    api.hello
      .status()
      .then((s) => setHelloOn(s.enabled))
      .catch(() => undefined)
  }, [])

  const unlockWithHello = async () => {
    if (helloBusy) return
    setHelloBusy(true)
    setError('')
    const res = await api.vault.unlockWithHello()
    setHelloBusy(false)
    if (res.ok) onDone()
    else setError(res.error ?? 'Windows Hello did not unlock Sentrix')
  }

  const submit = async () => {
    if (!pw || busy || waiting) return
    setBusy(true)
    setError('')
    const res = await api.vault.unlock(pw)
    setBusy(false)
    if (res.ok) {
      setPw('')
      if (res.notice) alert(res.notice)
      onDone()
      return
    }
    setError(res.error ?? 'Could not unlock')
    if (res.retryInMs) {
      setWaitUntil(Date.now() + res.retryInMs)
      setNow(Date.now())
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-lock">
          <Logo size={56} />
          <h1>Sentrix is locked</h1>
          <p className="muted">{helloOn ? 'Use Windows Hello or your master password.' : 'Enter your master password to unlock.'}</p>
        </div>
        {helloOn && (
          <>
            <button className="btn primary block hello-btn" onClick={unlockWithHello} disabled={helloBusy}>
              <Icon name="fingerprint" size={18} /> {helloBusy ? 'Waiting for Windows Hello…' : 'Unlock with Windows Hello'}
            </button>
            <div className="or">or</div>
          </>
        )}
        <PasswordInput value={pw} onChange={setPw} autoFocus={!helloOn} placeholder="Master password" onEnter={submit} />
        {error && <div className="error">{error}{waiting ? ` Try again in ${waiting}s.` : ''}</div>}
        <button className={`btn block${helloOn ? "" : " primary"}`} disabled={!pw || busy || waiting > 0} onClick={submit}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </div>
      <p className="auth-foot muted">Local only · Argon2id + AES-256-GCM · no network</p>
    </div>
  )
}
