import { randomUUID } from 'node:crypto'
import type { Entry } from '@shared/types'
import { sanitizeEntry } from './entry'

/** RFC 4180 CSV parser (quotes, escaped quotes, CRLF, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const s = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

const COLUMNS: Record<keyof Pick<Entry, 'title' | 'username' | 'password' | 'notes' | 'totp'> | 'url' | 'email', string[]> = {
  title: ['name', 'title', 'item name'],
  url: ['url', 'website', 'login_uri', 'uri', 'urls', 'web site'],
  username: ['username', 'login_username', 'user name', 'login', 'user'],
  email: ['email', 'e-mail'],
  password: ['password', 'login_password', 'pass'],
  notes: ['note', 'notes', 'extra', 'comments'],
  totp: ['totp', 'login_totp', 'otpauth', 'one-time password', 'otp']
}

/**
 * Import a CSV exported by Proton Pass, Chrome/Edge, Firefox, Bitwarden, LastPass, 1Password, etc.
 * Returns new entries (fresh ids).
 */
export function entriesFromCsv(text: string, now = Date.now()): Entry[] {
  const rows = parseCsv(text)
  if (rows.length < 2) return []
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (names: string[]) => header.findIndex((h) => names.includes(h))
  const idx = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, col(names)])) as Record<keyof typeof COLUMNS, number>
  if (idx.password < 0 && idx.notes < 0) throw new Error('Could not find a "password" column in this CSV')
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')
  const out: Entry[] = []
  for (const r of rows.slice(1)) {
    const password = get(r, idx.password)
    const url = get(r, idx.url)
    const username = get(r, idx.username) || get(r, idx.email)
    const notes = get(r, idx.notes)
    if (!password && !username && !url && !notes) continue
    const e = sanitizeEntry({
      id: randomUUID(),
      type: password || username || url ? 'login' : 'note',
      title: get(r, idx.title),
      username,
      password,
      urls: url ? url.split(/[\s,]+/).filter(Boolean) : [],
      notes,
      totp: get(r, idx.totp),
      tags: [],
      favorite: false,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      passwordHistory: []
    })
    if (e) {
      if (!e.title) {
        try {
          e.title = new URL(/:\/\//.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '')
        } catch {
          e.title = username || 'Imported item'
        }
      }
      out.push(e)
    }
  }
  return out
}

/** Escape a CSV field. Values are kept exact so the file re-imports into other managers correctly. */
function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function entriesToCsv(entries: Entry[]): string {
  const lines = ['name,url,username,password,notes,totp']
  for (const e of entries) {
    lines.push([e.title, e.urls.join(' '), e.username, e.password, e.notes, e.totp].map(csvField).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}
