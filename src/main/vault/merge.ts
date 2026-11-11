import type { Entry, MergeStats, Tombstone } from '@shared/types'

export const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000

export interface MergeInput {
  entries: Entry[]
  tombstones: Tombstone[]
}

/**
 * Merge `incoming` (from another device) into `local`.
 *  - Same id on both sides → the newer `updatedAt` wins.
 *  - A tombstone deletes an entry unless that entry was edited after the deletion.
 *  - Pure function: inputs are not mutated.
 */
export function mergeVaults(
  local: MergeInput,
  incoming: MergeInput,
  now: number = Date.now()
): { entries: Entry[]; tombstones: Tombstone[]; stats: MergeStats } {
  const stats: MergeStats = { added: 0, updated: 0, removed: 0, unchanged: 0 }
  const entries = new Map<string, Entry>(local.entries.map((e) => [e.id, e]))
  const tombs = new Map<string, number>(local.tombstones.map((t) => [t.id, t.deletedAt]))

  // 1. incoming tombstones
  for (const t of incoming.tombstones) {
    const prev = tombs.get(t.id)
    if (prev === undefined || t.deletedAt > prev) tombs.set(t.id, t.deletedAt)
    const existing = entries.get(t.id)
    if (existing && existing.updatedAt <= t.deletedAt) {
      entries.delete(t.id)
      stats.removed++
    }
  }

  // 2. incoming entries
  for (const inc of incoming.entries) {
    const deletedAt = tombs.get(inc.id)
    if (deletedAt !== undefined && deletedAt >= inc.updatedAt) continue // deleted after this edit
    const existing = entries.get(inc.id)
    if (!existing) {
      entries.set(inc.id, inc)
      tombs.delete(inc.id)
      stats.added++
    } else if (inc.updatedAt > existing.updatedAt) {
      entries.set(inc.id, inc)
      stats.updated++
    } else {
      stats.unchanged++
    }
  }

  // 3. drop tombstones for entries that still exist, and expired ones
  const tombstones: Tombstone[] = []
  for (const [id, deletedAt] of tombs) {
    if (entries.has(id)) continue
    if (now - deletedAt > TOMBSTONE_TTL_MS) continue
    tombstones.push({ id, deletedAt })
  }

  return { entries: [...entries.values()], tombstones, stats }
}
