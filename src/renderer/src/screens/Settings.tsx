import { useCallback, useEffect, useState } from 'react'
import type { HelloStatus, MergeStats, PairedBrowser, Settings } from '@shared/types'
import { Icon } from '../components/Icon'
import { Modal, PasswordInput, StrengthMeter, Toggle, useToast } from '../components/ui'

const api = window.sentrix

const statsText = (s: MergeStats) =>
  [`${s.added} added`, `${s.updated} updated`, s.removed ? `${s.removed} removed` : '', s.unchanged ? `${s.unchanged} already up to date` : ''].filter(Boolean).join(', ')

export function SettingsScreen() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [browsers, setBrowsers] = useState<Array<Omit<PairedBrowser, 'key'>>>([])
  const [vaultPath, setVaultPath] = useState('')
  const [version, setVersion] = useState('')
  const [bridge, setBridge] = useState<{ running: boolean; error: string | null } | null>(null)
  const [modal, setModal] = useState<null | 'password' | 'export' | 'hello' | { import: { token: string; name: string } }>(null)
  const [hello, setHello] = useState<HelloStatus | null>(null)
  const loadHello = useCallback(() => api.hello.status().then(setHello), [])
  const toast = useToast()

  const loadBrowsers = useCallback(() => api.browser.list().then(setBrowsers), [])
  useEffect(() => {
    api.settings.get().then(setSettings)
    api.app.state().then((s) => {
      setVaultPath(s.vaultPath)
      setVersion(s.version)
    })
    loadBrowsers()
    api.browser.status().then(setBridge)
    loadHello()
    return api.on('vault-changed', loadBrowsers)
  }, [loadBrowsers, loadHello])

  const update = async (patch: Partial<Settings>) => {
    setSettings(await api.settings.set(patch))
    api.browser.status().then(setBridge)
    toast('Settings saved')
  }

  const startImport = async () => {
    try {
      const picked = await api.transfer.pickImportFile()
      if (!picked) return
      if (picked.kind === 'sentrix') return setModal({ import: picked })
      if (!confirm(`Import logins from the CSV file "${picked.name}"?\n\nAfter importing, delete the CSV file — it is not encrypted.`)) return
      const res = await api.transfer.importCsv(picked.token)
      res.ok ? toast(`Imported: ${statsText(res.stats!)}`) : toast(res.error ?? 'Import failed', 'error')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const exportCsv = async () => {
    if (!confirm('This writes ALL your passwords to a plain, UNENCRYPTED text file that anyone with access to it can read.\n\nOnly do this to move to another password manager, and delete the file right after.\n\nContinue?')) return
    const res = await api.transfer.exportCsv()
    if (res.ok) toast(`Exported ${res.count} items (unencrypted!)`, 'info')
  }

  if (!settings) return null

  return (
    <div className="settings">
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      <section className="card section">
        <h3>
          <Icon name="shield" /> Security
        </h3>
        <div className="setting">
          <div>
            <strong>Auto-lock</strong>
            <p className="muted small">Lock after this long without activity. Sentrix also locks when Windows locks or sleeps.</p>
          </div>
          <select value={settings.autoLockMinutes} onChange={(e) => update({ autoLockMinutes: +e.target.value })}>
            {[1, 2, 5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m} minute{m > 1 ? 's' : ''}
              </option>
            ))}
            <option value={0}>Never (not recommended)</option>
          </select>
        </div>
        <div className="setting">
          <div>
            <strong>Clear clipboard</strong>
            <p className="muted small">Copied passwords are removed from the clipboard after this time.</p>
          </div>
          <select value={settings.clipboardClearSeconds} onChange={(e) => update({ clipboardClearSeconds: +e.target.value })}>
            {[10, 20, 30, 60, 120].map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
            <option value={0}>Never</option>
          </select>
        </div>
        <div className="setting">
          <div>
            <strong>
              <Icon name="fingerprint" size={15} /> Unlock with Windows Hello
            </strong>
            <p className="muted small">
              {hello === null
                ? 'Checking Windows Hello…'
                : hello.supported || hello.enabled
                  ? 'Use your PIN, fingerprint or face instead of typing the master password. The master password always works too.'
                  : 'Windows Hello is not set up on this PC. Add a PIN in Windows Settings → Accounts → Sign-in options, then come back.'}
            </p>
          </div>
          <Toggle
            label="Unlock with Windows Hello"
            hideLabel
            checked={!!hello?.enabled}
            disabled={!hello || (!hello.supported && !hello.enabled)}
            onChange={async (v) => {
              if (v) return setModal('hello')
              await api.hello.disable()
              await loadHello()
              toast('Windows Hello unlock turned off', 'info')
            }}
          />
        </div>
        <div className="setting">
          <Toggle label="Lock when the window is minimized" checked={settings.lockOnMinimize} onChange={(v) => update({ lockOnMinimize: v })} />
        </div>
        <div className="setting">
          <div>
            <strong>Master password</strong>
            <p className="muted small">Change the password that unlocks this vault.</p>
          </div>
          <button className="btn" onClick={() => setModal('password')}>
            Change…
          </button>
        </div>
      </section>

      <section className="card section">
        <h3>
          <Icon name="upload" /> Move passwords to another device
        </h3>
        <p className="muted small">
          Export an encrypted file, copy it to the other computer (USB stick, messaging yourself, etc.), then use <em>Import</em> there.
          Items are merged: new ones are added and the most recent edit of each item wins. Do this in both directions to keep two
          computers in sync.
        </p>
        <div className="btn-row">
          <button className="btn primary" onClick={() => setModal('export')}>
            <Icon name="download" size={16} /> Export encrypted file
          </button>
          <button className="btn" onClick={startImport}>
            <Icon name="upload" size={16} /> Import file…
          </button>
        </div>
        <p className="muted small">
          Import also accepts a <strong>CSV</strong> exported from Proton Pass, Chrome, Edge, Firefox, Bitwarden, LastPass or 1Password.
        </p>
        <button className="link danger" onClick={exportCsv}>
          Export unencrypted CSV…
        </button>
      </section>

      <section className="card section">
        <h3>
          <Icon name="browser" /> Browser autofill
        </h3>
        <div className="setting">
          <Toggle label="Allow the Sentrix browser extension to connect" checked={settings.browserIntegration} onChange={(v) => update({ browserIntegration: v })} />
          {settings.browserIntegration && bridge && (
            <span className={`small ${bridge.running ? 'ok-text' : 'error-text'}`}>{bridge.running ? 'Listening on this computer only' : bridge.error ?? 'Not running'}</span>
          )}
        </div>
        <details className="howto">
          <summary>How to install the extension (Chrome / Edge / Brave)</summary>
          <ol>
            <li>
              Open <code>chrome://extensions</code> (or <code>edge://extensions</code>) and switch on <strong>Developer mode</strong>.
            </li>
            <li>
              Click <strong>Load unpacked</strong> and choose the Sentrix <code>extension</code> folder.{' '}
              <button className="link" onClick={() => api.browser.openExtensionFolder()}>
                Show the folder
              </button>
            </li>
            <li>Click the Sentrix icon in the toolbar → <strong>Connect to Sentrix</strong>, then type the code it shows into the window that pops up here.</li>
          </ol>
          <p className="muted small">
            The extension talks to this app only on your own computer (127.0.0.1). The app accepts connections only from the Sentrix extension, every message is
            encrypted with a key created when you pair, and nothing ever goes over the internet.
          </p>
        </details>
        <h4>Connected browsers</h4>
        {browsers.length === 0 ? (
          <p className="muted small">No browsers connected yet.</p>
        ) : (
          <ul className="browser-list">
            {browsers.map((b) => (
              <li key={b.clientId}>
                <Icon name="browser" />
                <div>
                  <strong>{b.name}</strong>
                  <span className="muted small">
                    Connected {new Date(b.createdAt).toLocaleDateString()} · last used {new Date(b.lastUsedAt).toLocaleString()}
                  </span>
                </div>
                <button
                  className="btn danger small"
                  onClick={async () => {
                    await api.browser.revoke(b.clientId)
                    toast('Browser disconnected', 'info')
                  }}
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card section">
        <h3>
          <Icon name="info" /> About
        </h3>
        <p className="small">
          Sentrix keeps everything on this computer. Your vault is encrypted with <strong>AES-256-GCM</strong> using a key derived from your master
          password with <strong>Argon2id</strong> (64 MiB, 3 passes). The app never connects to the internet; the browser extension
          reaches it only on this computer (127.0.0.1).
        </p>
        <p className="muted small">
          Vault file: <code>{vaultPath}</code>
        </p>
        <div className="setting">
          <div>
            <strong>Sentrix {version}</strong>
            <p className="muted small">Sentrix never checks for updates by itself. This opens the releases page in your browser.</p>
          </div>
          <button className="btn" onClick={() => api.app.openExternal('https://github.com/zion07740/sentrix/releases')}>
            <Icon name="external" size={15} /> Check for updates
          </button>
        </div>
      </section>

      {modal === 'password' && <ChangePasswordModal onClose={() => setModal(null)} />}
      {modal === 'export' && <ExportModal onClose={() => setModal(null)} />}
      {modal === 'hello' && (
        <HelloModal
          onClose={() => {
            setModal(null)
            loadHello()
          }}
        />
      )}
      {modal && typeof modal === 'object' && <ImportModal file={modal.import} onClose={() => setModal(null)} />}
    </div>
  )
}

function HelloModal({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toast = useToast()
  const submit = async () => {
    if (!pw || busy) return
    setBusy(true)
    setError('')
    const res = await api.hello.enable(pw)
    setBusy(false)
    if (res.ok) {
      toast('Windows Hello unlock is on')
      onClose()
    } else setError(res.error ?? 'Could not turn on Windows Hello')
  }
  return (
    <Modal title="Turn on Windows Hello" onClose={busy ? undefined : onClose}>
      <p className="muted small">
        Confirm your master password. Windows will then ask for your PIN, fingerprint or face (twice, to check it works). Sentrix keeps a copy of your
        vault key that only Windows Hello on this PC can unlock.
      </p>
      <label className="field">
        <span>Master password</span>
        <PasswordInput value={pw} onChange={setPw} autoFocus onEnter={submit} />
      </label>
      {busy && <p className="small">Follow the Windows Hello prompt…</p>}
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" disabled={!pw || busy} onClick={submit}>
          {busy ? 'Waiting for Windows Hello…' : 'Continue'}
        </button>
      </div>
    </Modal>
  )
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const ok = current && next.length >= 8 && next === confirmPw && !busy
  const submit = async () => {
    if (!ok) return
    setBusy(true)
    const res = await api.vault.changePassword(current, next)
    setBusy(false)
    if (res.ok) {
      toast('Master password changed')
      onClose()
    } else setError(res.error ?? 'Failed')
  }
  return (
    <Modal title="Change master password" onClose={onClose}>
      <label className="field">
        <span>Current master password</span>
        <PasswordInput value={current} onChange={setCurrent} autoFocus />
      </label>
      <label className="field">
        <span>New master password</span>
        <PasswordInput value={next} onChange={setNext} />
      </label>
      <StrengthMeter password={next} />
      <label className="field">
        <span>Confirm new master password</span>
        <PasswordInput value={confirmPw} onChange={setConfirmPw} onEnter={submit} />
      </label>
      {next && confirmPw && next !== confirmPw && <div className="error">Passwords do not match</div>}
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!ok} onClick={submit}>
          {busy ? 'Re-encrypting…' : 'Change password'}
        </button>
      </div>
    </Modal>
  )
}

function ExportModal({ onClose }: { onClose: () => void }) {
  const [pw, setPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toast = useToast()
  const ok = pw.length >= 8 && pw === confirmPw && !busy
  const submit = async () => {
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      const res = await api.transfer.exportEncrypted(pw)
      if (res.ok) {
        toast(`Exported ${res.count} items`)
        onClose()
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="Export encrypted file" onClose={onClose}>
      <p className="muted small">
        Choose a password for this file. You'll need it when importing on the other device. It can be your master password or a different one —
        a strong passphrase is best, especially if you send the file over the internet.
      </p>
      <label className="field">
        <span>Export password</span>
        <PasswordInput value={pw} onChange={setPw} autoFocus />
      </label>
      <StrengthMeter password={pw} />
      <label className="field">
        <span>Confirm export password</span>
        <PasswordInput value={confirmPw} onChange={setConfirmPw} onEnter={submit} />
      </label>
      {pw && pw.length < 8 && <div className="error">Use at least 8 characters</div>}
      {pw && confirmPw && pw !== confirmPw && <div className="error">Passwords do not match</div>}
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!ok} onClick={submit}>
          {busy ? 'Encrypting…' : 'Choose location & export'}
        </button>
      </div>
    </Modal>
  )
}

function ImportModal({ file, onClose }: { file: { token: string; name: string }; onClose: () => void }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stats, setStats] = useState<MergeStats | null>(null)
  const submit = async () => {
    if (!pw || busy) return
    setBusy(true)
    setError('')
    const res = await api.transfer.importEncrypted(file.token, pw)
    setBusy(false)
    if (res.ok) setStats(res.stats!)
    else setError(res.error ?? 'Import failed')
  }
  return (
    <Modal title="Import encrypted file" onClose={onClose}>
      {stats ? (
        <>
          <div className="import-done">
            <Icon name="check" size={28} />
            <p>
              <strong>Import complete.</strong>
              <br />
              {statsText(stats)}.
            </p>
          </div>
          <div className="modal-actions">
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">
            File: <code>{file.name}</code>
          </p>
          <label className="field">
            <span>Export password for this file</span>
            <PasswordInput value={pw} onChange={setPw} autoFocus onEnter={submit} />
          </label>
          {error && <div className="error">{error}</div>}
          <div className="modal-actions">
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!pw || busy} onClick={submit}>
              {busy ? 'Decrypting…' : 'Import & merge'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
