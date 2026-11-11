import { createHash } from 'node:crypto'
import type { Entry, HealthIssue, HealthItem, HealthReport } from '@shared/types'
import { strength } from '@shared/strength'
import { hostOf } from './vault/entry'
import { isInsecureUrl } from './bridge/match'

export const OLD_AFTER_DAYS = 365
const DAY = 86_400_000

/** zxcvbn is slow-ish; scores are cached per entry version and never stored on disk. */
const scoreCache = new Map<string, number>()

function scoreOf(e: Entry): number {
  const key = `${e.id}:${e.updatedAt}`
  let s = scoreCache.get(key)
  if (s === undefined) {
    s = e.password ? strength(e.password, [e.title, e.username, hostOf(e.urls[0])].filter(Boolean)).score : 0
    if (scoreCache.size > 5000) scoreCache.clear()
    scoreCache.set(key, s)
  }
  return s
}

/**
 * Checks every login in the vault. The result never contains a password,
 * only ids, titles and issue flags.
 */
export function buildHealthReport(entries: Entry[], now = Date.now()): HealthReport {
  const logins = entries.filter((e) => e.type === 'login' && e.trashedAt === null)

  // Group by a hash of the password so equal passwords can be counted without copying them around.
  const groups = new Map<string, number>()
  const hashes = new Map<string, string>()
  for (const e of logins) {
    if (!e.password) continue
    const h = createHash('sha256').update(e.password).digest('hex')
    hashes.set(e.id, h)
    groups.set(h, (groups.get(h) ?? 0) + 1)
  }

  const counts: Record<HealthIssue, number> = { weak: 0, reused: 0, old: 0, insecure: 0, no2fa: 0 }
  const items: HealthItem[] = []
  let healthy = 0

  for (const e of logins) {
    const issues: HealthIssue[] = []
    const s = scoreOf(e)
    if (!e.password || s <= 2) issues.push('weak')
    const h = hashes.get(e.id)
    const reusedCount = h ? (groups.get(h) ?? 1) - 1 : 0
    if (reusedCount > 0) issues.push('reused')
    const changedAt = e.passwordHistory[0]?.changedAt ?? e.createdAt
    const ageDays = Math.max(0, Math.floor((now - changedAt) / DAY))
    if (e.password && ageDays > OLD_AFTER_DAYS) issues.push('old')
    if (e.urls.some(isInsecureUrl)) issues.push('insecure')
    if (!e.totp) issues.push('no2fa')

    for (const i of issues) counts[i]++
    if (!issues.some((i) => i === 'weak' || i === 'reused' || i === 'insecure')) healthy++
    if (issues.length) {
      items.push({ id: e.id, title: e.title, username: e.username, host: hostOf(e.urls[0]), issues, strength: s, reusedCount, ageDays })
    }
  }

  const rank = (i: HealthItem) =>
    (i.issues.includes('weak') ? 8 : 0) + (i.issues.includes('reused') ? 4 : 0) + (i.issues.includes('insecure') ? 2 : 0) + (i.issues.includes('old') ? 1 : 0)
  items.sort((a, b) => rank(b) - rank(a) || a.title.localeCompare(b.title))

  return { score: logins.length ? Math.round((healthy / logins.length) * 100) : 100, total: logins.length, counts, items }
}
