import { randomUUID } from 'node:crypto'
import type { Entry, EntryInput, EntrySummary, Tombstone } from '@shared/types'

const MAX_TEXT = 10_000
const MAX_NOTES = 100_000
const MAX_URLS = 20
const MAX_TAGS = 30
const MAX_HISTORY = 10

const str = (v: unknown, max = MAX_TEXT): string => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback
const strList = (v: unknown, maxItems: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 2048)).filter(Boolean).slice(0, maxItems) : []

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validate and normalize an entry that came from an untrusted source (file, renderer, extension). */
export function sanitizeEntry(raw: unknown, now = Date.now()): Entry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && UUID_RE.test(r.id) ? r.id.toLowerCase() : null
  if (!id) return null
  const createdAt = num(r.createdAt, now)
  const history = Array.isArray(r.passwordHistory)
    ? r.passwordHistory
        .filter((h): h is { password: string; changedAt: number } => !!h && typeof h === 'object' && typeof (h as { password?: unknown }).password === 'string')
        .map((h) => ({ password: str(h.password), changedAt: num(h.changedAt, now) }))
        .slice(0, MAX_HISTORY)
    : []
  return {
    id,
    type: r.type === 'note' ? 'note' : 'login',
    title: str(r.title, 500),
    username: str(r.username, 1000),
    password: str(r.password),
    urls: strList(r.urls, MAX_URLS),
    notes: str(r.notes, MAX_NOTES),
    totp: str(r.totp, 2000).trim(),
    tags: strList(r.tags, MAX_TAGS).map((t) => t.slice(0, 50)),
    favorite: r.favorite === true,
    createdAt,
    updatedAt: num(r.updatedAt, createdAt),
    trashedAt: typeof r.trashedAt === 'number' && Number.isFinite(r.trashedAt) ? Math.floor(r.trashedAt) : null,
    passwordHistory: history
  }
}

export function sanitizeTombstone(raw: unknown): Tombstone | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !UUID_RE.test(r.id)) return null
  if (typeof r.deletedAt !== 'number' || !Number.isFinite(r.deletedAt)) return null
  return { id: r.id.toLowerCase(), deletedAt: Math.floor(r.deletedAt) }
}

/** Apply a create/update from the UI. Keeps a short password history when the password changes. */
export function applyInput(input: EntryInput, existing: Entry | undefined, now = Date.now()): Entry {
  const base: Entry = existing ?? {
    id: randomUUID(),
    type: 'login',
    title: '',
    username: '',
    password: '',
    urls: [],
    notes: '',
    totp: '',
    tags: [],
    favorite: false,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    passwordHistory: []
  }
  const next = sanitizeEntry({ ...base, ...input, id: base.id, createdAt: base.createdAt, trashedAt: base.trashedAt, passwordHistory: base.passwordHistory, updatedAt: now }, now)
  if (!next) throw new Error('Invalid entry')
  if (existing && existing.password && existing.password !== next.password) {
    next.passwordHistory = [{ password: existing.password, changedAt: now }, ...existing.passwordHistory].slice(0, MAX_HISTORY)
  }
  if (!next.title.trim()) next.title = hostOf(next.urls[0]) || next.username || 'Untitled'
  return next
}

export function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function summarize(e: Entry): EntrySummary {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    username: e.username,
    host: hostOf(e.urls[0]),
    favorite: e.favorite,
    hasTotp: !!e.totp,
    tags: e.tags,
    updatedAt: e.updatedAt,
    trashedAt: e.trashedAt
  }
}
