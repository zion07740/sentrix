import { useCallback, useEffect, useState } from 'react'
import type { GeneratorOptions, PassphraseOptions } from '@shared/types'
import { Icon } from '../components/Icon'
import { StrengthMeter, Toggle, useToast } from '../components/ui'

const api = window.sentrix

export function GeneratorPanel({ standalone, onUse }: { standalone?: boolean; onUse?: (p: string) => void }) {
  const [mode, setMode] = useState<'password' | 'passphrase'>('password')
  const [pw, setPw] = useState<GeneratorOptions>({ length: 20, lowercase: true, uppercase: true, digits: true, symbols: true, excludeAmbiguous: true })
  const [pp, setPp] = useState<PassphraseOptions>({ words: 5, separator: '-', capitalize: true, includeNumber: true })
  const [value, setValue] = useState('')
  const toast = useToast()

  const generate = useCallback(async () => {
    setValue(mode === 'password' ? await api.generator.password(pw) : await api.generator.passphrase(pp))
  }, [mode, pw, pp])

  useEffect(() => {
    generate()
  }, [generate])

  return (
    <div className={standalone ? 'generator standalone' : 'generator'}>
      {standalone && (
        <header className="page-head">
          <h1>Password generator</h1>
          <p className="muted">Generated on this device with a cryptographically secure random source.</p>
        </header>
      )}
      <div className="segmented">
        <button type="button" className={mode === 'password' ? 'on' : ''} onClick={() => setMode('password')}>
          Random password
        </button>
        <button type="button" className={mode === 'passphrase' ? 'on' : ''} onClick={() => setMode('passphrase')}>
          Passphrase
        </button>
      </div>

      <div className="gen-output mono">{value}</div>
      <StrengthMeter password={value} />

      <div className="gen-actions">
        <button type="button" className="btn" onClick={generate}>
          <Icon name="refresh" size={16} /> Regenerate
        </button>
        {onUse ? (
          <button type="button" className="btn primary" onClick={() => onUse(value)}>
            <Icon name="check" size={16} /> Use this
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={() => api.clipboard.copyText(value).then(() => toast('Copied · clears automatically'))}>
            <Icon name="copy" size={16} /> Copy
          </button>
        )}
      </div>

      <div className="gen-options">
        {mode === 'password' ? (
          <>
            <label className="range">
              <span>
                Length <strong>{pw.length}</strong>
              </span>
              <input type="range" min={8} max={64} value={pw.length} onChange={(e) => setPw({ ...pw, length: +e.target.value })} />
            </label>
            <Toggle label="Lowercase (a-z)" checked={pw.lowercase} onChange={(v) => setPw({ ...pw, lowercase: v })} />
            <Toggle label="Uppercase (A-Z)" checked={pw.uppercase} onChange={(v) => setPw({ ...pw, uppercase: v })} />
            <Toggle label="Numbers (0-9)" checked={pw.digits} onChange={(v) => setPw({ ...pw, digits: v })} />
            <Toggle label="Symbols (!@#…)" checked={pw.symbols} onChange={(v) => setPw({ ...pw, symbols: v })} />
            <Toggle label="Avoid look-alikes (l, 1, O, 0)" checked={pw.excludeAmbiguous} onChange={(v) => setPw({ ...pw, excludeAmbiguous: v })} />
          </>
        ) : (
          <>
            <label className="range">
              <span>
                Words <strong>{pp.words}</strong>
              </span>
              <input type="range" min={3} max={12} value={pp.words} onChange={(e) => setPp({ ...pp, words: +e.target.value })} />
            </label>
            <label className="field inline">
              <span>Separator</span>
              <input value={pp.separator} maxLength={3} onChange={(e) => setPp({ ...pp, separator: e.target.value })} />
            </label>
            <Toggle label="Capitalize words" checked={pp.capitalize} onChange={(v) => setPp({ ...pp, capitalize: v })} />
            <Toggle label="Include a number" checked={pp.includeNumber} onChange={(v) => setPp({ ...pp, includeNumber: v })} />
          </>
        )}
      </div>
    </div>
  )
}
