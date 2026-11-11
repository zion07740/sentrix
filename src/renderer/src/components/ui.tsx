import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { SCORE_LABEL, strength } from '@shared/strength'

// ---------------- toasts ----------------

interface Toast {
  id: number
  text: string
  kind: 'ok' | 'error' | 'info'
}
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => undefined)
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(1)
  const push = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = next.current++
    setToasts((t) => [...t.slice(-3), { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <Icon name={t.kind === 'error' ? 'x' : t.kind === 'info' ? 'info' : 'check'} size={16} />
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

// ---------------- small building blocks ----------------

export function IconButton({
  icon,
  label,
  onClick,
  active,
  danger,
  disabled
}: {
  icon: IconName
  label: string
  onClick?: () => void
  active?: boolean
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`icon-btn${active ? ' active' : ''}${danger ? ' danger' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={disabled}
    >
      <Icon name={icon} size={17} />
    </button>
  )
}

export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  id,
  onEnter
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  id?: string
  onEnter?: () => void
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="pw-input">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        className="mono"
        onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
      />
      <IconButton icon={show ? 'eyeOff' : 'eye'} label={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)} />
    </div>
  )
}

export function StrengthMeter({ password, userInputs }: { password: string; userInputs?: string[] }) {
  const result = password ? strength(password, userInputs) : null
  const score = result?.score ?? -1
  return (
    <div className="strength" aria-live="polite">
      <div className="strength-bars">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={i <= score ? `on s${score}` : ''} />
        ))}
      </div>
      <div className="strength-text">
        {result ? (
          <>
            <strong className={`s${result.score}`}>{SCORE_LABEL[result.score]}</strong>
            {result.feedback.warning ? <span> · {result.feedback.warning}</span> : null}
          </>
        ) : (
          <span className="muted">Strength</span>
        )}
      </div>
    </div>
  )
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose?: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose?.()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          {onClose && <IconButton icon="x" label="Close" onClick={onClose} />}
        </div>
        {children}
      </div>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  hideLabel
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
  /** the label is shown elsewhere; keep it for screen readers only */
  hideLabel?: boolean
}) {
  return (
    <label className={`toggle${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track">
        <span className="toggle-thumb" />
      </span>
      {!hideLabel && <span>{label}</span>}
    </label>
  )
}

export function Favicon({ host, title, size = 36 }: { host: string; title: string; size?: number }) {
  // No network: a coloured monogram instead of a downloaded favicon.
  const letter = (title || host || '?').trim()[0] ?? '?'
  const seed = (host || title || '?').replace(/^www\./, '')
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360
  return (
    <span className="favicon" style={{ width: size, height: size, background: `hsl(${h} 55% 42%)`, fontSize: size * 0.42 }}>
      {letter.toUpperCase()}
    </span>
  )
}
