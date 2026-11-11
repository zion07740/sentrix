import { useMemo, useState } from 'react'
import type { HealthIssue, HealthReport } from '@shared/types'
import { Icon, type IconName } from '../components/Icon'
import { Favicon } from '../components/ui'

const TILES: Array<{ id: HealthIssue; label: string; icon: IconName; hint: string }> = [
  { id: 'weak', label: 'Weak', icon: 'key', hint: 'Easy to guess. Generate a new one.' },
  { id: 'reused', label: 'Reused', icon: 'copy', hint: 'Used on more than one site. One leak exposes them all.' },
  { id: 'old', label: 'Old', icon: 'clock', hint: 'Not changed in over a year.' },
  { id: 'insecure', label: 'Insecure site', icon: 'globe', hint: 'Saved for an http:// address, so the password travels unencrypted.' },
  { id: 'no2fa', label: 'No 2FA', icon: 'shield', hint: 'No 2FA code saved. Turn on two-factor login where the site offers it.' }
]

const ISSUE_TEXT: Record<HealthIssue, string> = {
  weak: 'Weak',
  reused: 'Reused',
  old: 'Old',
  insecure: 'http://',
  no2fa: 'No 2FA'
}

export function HealthScreen({ report, onOpen }: { report: HealthReport | null; onOpen: (id: string) => void }) {
  const [focus, setFocus] = useState<HealthIssue | null>(null)

  const rows = useMemo(() => {
    if (!report) return []
    // "No 2FA" only appears when picked explicitly, so it doesn't bury real problems.
    return report.items.filter((i) => (focus ? i.issues.includes(focus) : i.issues.some((x) => x !== 'no2fa')))
  }, [report, focus])

  if (!report) return null
  const tone = report.score >= 80 ? 'good' : report.score >= 50 ? 'fair' : 'bad'
  const circ = 2 * Math.PI * 44

  return (
    <div className="health">
      <header className="page-head">
        <h1>Password health</h1>
        <p className="muted">Checked on this computer. Nothing is sent anywhere.</p>
      </header>

      <section className="card health-hero">
        <svg width="112" height="112" viewBox="0 0 112 112" className={`score-ring ${tone}`} aria-label={`Score ${report.score} out of 100`}>
          <circle cx="56" cy="56" r="44" className="ring-bg" />
          <circle cx="56" cy="56" r="44" className="ring" strokeDasharray={`${(report.score / 100) * circ} ${circ}`} transform="rotate(-90 56 56)" />
          <text x="56" y="62" textAnchor="middle">
            {report.score}
          </text>
        </svg>
        <div>
          <h2>{report.total === 0 ? 'No logins yet' : report.score === 100 ? 'Looking good' : tone === 'bad' ? 'Needs attention' : 'Room to improve'}</h2>
          <p className="muted">
            {report.total} login{report.total === 1 ? '' : 's'} checked.{' '}
            {report.total > 0 && (() => {
              const ok = Math.round((report.score / 100) * report.total)
              return `${ok} ${ok === 1 ? 'has' : 'have'} no weak, reused or insecure password.`
            })()}
          </p>
        </div>
      </section>

      <div className="health-tiles">
        {TILES.map((t) => (
          <button
            key={t.id}
            className={`health-tile${focus === t.id ? ' active' : ''}${report.counts[t.id] && t.id !== 'no2fa' ? ' has-issues' : ''}`}
            onClick={() => setFocus(focus === t.id ? null : t.id)}
            title={t.hint}
          >
            <Icon name={t.icon} size={18} />
            <strong>{report.counts[t.id]}</strong>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {focus && <p className="muted small">{TILES.find((t) => t.id === focus)?.hint}</p>}

      <ul className="health-list card">
        {rows.map((i) => (
          <li key={i.id}>
            <button className="row" onClick={() => onOpen(i.id)}>
              <Favicon host={i.host} title={i.title} />
              <span className="row-text">
                <span className="row-title">{i.title}</span>
                <span className="row-sub">{i.username || i.host || '—'}</span>
              </span>
              <span className="chips">
                {i.issues
                  .filter((x) => focus === 'no2fa' || x !== 'no2fa')
                  .map((x) => (
                    <span key={x} className={`chip chip-${x}`}>
                      {x === 'reused' ? `Reused ×${i.reusedCount + 1}` : x === 'old' ? `${Math.floor(i.ageDays / 365)}y old` : ISSUE_TEXT[x]}
                    </span>
                  ))}
              </span>
              <Icon name="arrowLeft" size={16} className="go" />
            </button>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="empty">
            <Icon name="check" size={20} />
            <span>{focus ? 'Nothing in this group.' : 'No problems found.'}</span>
          </li>
        )}
      </ul>
    </div>
  )
}
