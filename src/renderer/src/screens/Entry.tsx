import { useEffect, useState } from 'react'
import type { CopyField, Entry, EntryInput, EntryType, TotpCode } from '@shared/types'
import { Icon } from '../components/Icon'
import { Favicon, IconButton, PasswordInput, StrengthMeter, useToast } from '../components/ui'
import { GeneratorPanel } from './Generator'

const api = window.sentrix

const hostOf = (url: string) => {
  try {
    return new URL(/:\/\//.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
const fmtDate = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function useCopy() {
  const toast = useToast()
  return async (id: string, field: CopyField, label: string) => {
    const ok = await api.clipboard.copyField(id, field)
    toast(ok ? `${label} copied · clears automatically` : `Nothing to copy`, ok ? 'ok' : 'info')
  }
}

function TotpField({ id }: { id: string }) {
  const [code, setCode] = useState<TotpCode | null>(null)
  const copy = useCopy()
  useEffect(() => {
    let alive = true
    const tick = () => api.vault.totp(id).then((c) => alive && setCode(c))
    tick()
    const t = setInterval(tick, 1000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [id])
  if (!code) return <div className="field-value muted">Invalid 2FA secret</div>
  const pct = code.remaining / code.period
  return (
    <div className="field-row">
      <div className="totp">
        <span className="mono totp-code">
          {code.code.slice(0, Math.ceil(code.code.length / 2))} {code.code.slice(Math.ceil(code.code.length / 2))}
        </span>
        <svg width="22" height="22" viewBox="0 0 22 22" className={code.remaining <= 5 ? 'ending' : ''}>
          <circle cx="11" cy="11" r="9" className="ring-bg" />
          <circle cx="11" cy="11" r="9" className="ring" strokeDasharray={`${pct * 56.5} 56.5`} transform="rotate(-90 11 11)" />
        </svg>
        <span className="muted small">{code.remaining}s</span>
      </div>
      <IconButton icon="copy" label="Copy code" onClick={() => copy(id, 'totp', '2FA code')} />
    </div>
  )
}

export function EntryView({ entry, onEdit, onChanged, onDeleted }: { entry: Entry; onEdit: () => void; onChanged: () => void; onDeleted: () => void }) {
  const [reveal, setReveal] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const copy = useCopy()
  const toast = useToast()
  const trashed = entry.trashedAt !== null

  const toggleFav = async () => {
    await api.vault.save({ ...entry, favorite: !entry.favorite })
    onChanged()
  }

  return (
    <div className="detail">
      <header className="detail-head">
        {entry.type === 'note' ? (
          <span className="favicon note big">
            <Icon name="note" size={26} />
          </span>
        ) : (
          <Favicon host={hostOf(entry.urls[0] ?? '')} title={entry.title} size={52} />
        )}
        <div className="detail-title">
          <h2>{entry.title}</h2>
          <span className="muted">{entry.type === 'note' ? 'Secure note' : hostOf(entry.urls[0] ?? '') || 'Login'}</span>
        </div>
        <div className="detail-actions">
          {trashed ? (
            <>
              <button
                className="btn"
                onClick={async () => {
                  await api.vault.restore(entry.id)
                  toast('Restored')
                  onChanged()
                }}
              >
                <Icon name="restore" size={16} /> Restore
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  if (confirm(`Permanently delete "${entry.title}"? This cannot be undone.`)) {
                    await api.vault.deleteForever(entry.id)
                    onDeleted()
                  }
                }}
              >
                <Icon name="trash" size={16} /> Delete forever
              </button>
            </>
          ) : (
            <>
              <IconButton icon="star" label={entry.favorite ? 'Remove from favorites' : 'Add to favorites'} active={entry.favorite} onClick={toggleFav} />
              <button className="btn" onClick={onEdit}>
                <Icon name="edit" size={16} /> Edit
              </button>
              <IconButton
                icon="trash"
                label="Move to trash"
                danger
                onClick={async () => {
                  await api.vault.trash(entry.id)
                  toast('Moved to trash', 'info')
                  onDeleted()
                }}
              />
            </>
          )}
        </div>
      </header>

      <div className="card">
        {entry.type === 'login' && (
          <>
            <div className="field-block">
              <label>Username</label>
              <div className="field-row">
                <div className="field-value">{entry.username || <span className="muted">—</span>}</div>
                {entry.username && <IconButton icon="copy" label="Copy username" onClick={() => copy(entry.id, 'username', 'Username')} />}
              </div>
            </div>
            <div className="field-block">
              <label>Password</label>
              <div className="field-row">
                <div className="field-value mono">{entry.password ? (reveal ? <PasswordColored value={entry.password} /> : '•'.repeat(Math.min(16, entry.password.length))) : <span className="muted">—</span>}</div>
                {entry.password && (
                  <>
                    <IconButton icon={reveal ? 'eyeOff' : 'eye'} label={reveal ? 'Hide' : 'Reveal'} onClick={() => setReveal(!reveal)} />
                    <IconButton icon="copy" label="Copy password" onClick={() => copy(entry.id, 'password', 'Password')} />
                  </>
                )}
              </div>
            </div>
            {entry.totp && (
              <div className="field-block">
                <label>2FA code (TOTP)</label>
                <TotpField id={entry.id} />
              </div>
            )}
          </>
        )}
        {entry.urls.length > 0 && (
          <div className="field-block">
            <label>Website{entry.urls.length > 1 ? 's' : ''}</label>
            {entry.urls.map((u) => (
              <div className="field-row" key={u}>
                <div className="field-value">{u}</div>
                <IconButton icon="external" label="Open in browser" onClick={() => api.app.openExternal(/:\/\//.test(u) ? u : `https://${u}`)} />
              </div>
            ))}
          </div>
        )}
      </div>

      {entry.notes && (
        <div className="card">
          <div className="field-block">
            <label>Notes</label>
            <div className="notes">{entry.notes}</div>
          </div>
        </div>
      )}

      {entry.tags.length > 0 && (
        <div className="tags">
          {entry.tags.map((t) => (
            <span className="tag" key={t}>
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="meta muted small">
        <span>Modified {fmtDate(entry.updatedAt)}</span>
        <span>Created {fmtDate(entry.createdAt)}</span>
        {entry.passwordHistory.length > 0 && (
          <button className="link" onClick={() => setShowHistory(!showHistory)}>
            Password history ({entry.passwordHistory.length})
          </button>
        )}
      </div>
      {showHistory && (
        <div className="card">
          {entry.passwordHistory.map((h, i) => (
            <div className="field-row history" key={i}>
              <div className="field-value mono">{h.password}</div>
              <span className="muted small">{fmtDate(h.changedAt)}</span>
              <IconButton icon="copy" label="Copy old password" onClick={() => api.clipboard.copyText(h.password).then(() => toast('Old password copied'))} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Digits and symbols coloured differently, so 0/O and 1/l are easy to tell apart. */
function PasswordColored({ value }: { value: string }) {
  return (
    <span className="pw-colored">
      {[...value].map((c, i) => (
        <span key={i} className={/[0-9]/.test(c) ? 'd' : /[a-zA-Z]/.test(c) ? '' : 's'}>
          {c}
        </span>
      ))}
    </span>
  )
}

export function EntryEditor({ type, entry, onCancel, onSaved }: { type: EntryType; entry: Entry | null; onCancel: () => void; onSaved: (e: Entry) => void }) {
  const [form, setForm] = useState<EntryInput>(
    entry
      ? { id: entry.id, type: entry.type, title: entry.title, username: entry.username, password: entry.password, urls: entry.urls.length ? entry.urls : [''], notes: entry.notes, totp: entry.totp, tags: entry.tags, favorite: entry.favorite }
      : { type, title: '', username: '', password: '', urls: [''], notes: '', totp: '', tags: [], favorite: false }
  )
  const [tagText, setTagText] = useState(form.tags.join(', '))
  const [showGen, setShowGen] = useState(false)
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const set = <K extends keyof EntryInput>(k: K, v: EntryInput[K]) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    if (!entry && type === 'login') api.generator.password({ length: 20, lowercase: true, uppercase: true, digits: true, symbols: true, excludeAmbiguous: true }).then((p) => set('password', p))
  }, [entry, type])

  const save = async () => {
    setSaving(true)
    try {
      const saved = await api.vault.save({
        ...form,
        urls: form.urls.map((u) => u.trim()).filter(Boolean),
        tags: tagText.split(',').map((t) => t.trim()).filter(Boolean)
      })
      toast(entry ? 'Saved' : 'Added to vault')
      onSaved(saved)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="detail editor"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <header className="detail-head">
        <h2>{entry ? `Edit ${form.type === 'note' ? 'note' : 'login'}` : form.type === 'note' ? 'New secure note' : 'New login'}</h2>
        <div className="detail-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            <Icon name="check" size={16} /> Save
          </button>
        </div>
      </header>

      <div className="card">
        <label className="field">
          <span>Title</span>
          <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder={form.type === 'note' ? 'Wi-Fi password, recovery codes…' : 'e.g. Gmail'} autoFocus />
        </label>
        {form.type === 'login' && (
          <>
            <label className="field">
              <span>Username or email</span>
              <input value={form.username} onChange={(e) => set('username', e.target.value)} spellCheck={false} autoComplete="off" />
            </label>
            <div className="field">
              <span>Password</span>
              <div className="with-btn">
                <PasswordInput value={form.password} onChange={(v) => set('password', v)} />
                <IconButton icon="wand" label="Generate password" active={showGen} onClick={() => setShowGen(!showGen)} />
              </div>
              {form.password && <StrengthMeter password={form.password} userInputs={[form.username, form.title]} />}
              {showGen && (
                <div className="inline-gen">
                  <GeneratorPanel
                    onUse={(p) => {
                      set('password', p)
                      setShowGen(false)
                    }}
                  />
                </div>
              )}
            </div>
            <div className="field">
              <span>Websites</span>
              {form.urls.map((u, i) => (
                <div className="with-btn" key={i}>
                  <input
                    value={u}
                    onChange={(e) => set('urls', form.urls.map((x, j) => (j === i ? e.target.value : x)))}
                    placeholder="https://example.com"
                    spellCheck={false}
                  />
                  {form.urls.length > 1 && <IconButton icon="x" label="Remove website" onClick={() => set('urls', form.urls.filter((_, j) => j !== i))} />}
                </div>
              ))}
              <button type="button" className="link" onClick={() => set('urls', [...form.urls, ''])}>
                + Add another website
              </button>
            </div>
            <label className="field">
              <span>2FA secret (optional)</span>
              <input
                value={form.totp}
                onChange={(e) => set('totp', e.target.value)}
                placeholder="Base32 secret or otpauth:// link from the site's 2FA setup"
                className="mono"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          </>
        )}
        <label className="field">
          <span>Notes</span>
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={form.type === 'note' ? 10 : 4} />
        </label>
        <label className="field">
          <span>Tags (comma separated)</span>
          <input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="work, finance" />
        </label>
      </div>
    </form>
  )
}
