import { describe, expect, it } from 'vitest'
import { mergeVaults, TOMBSTONE_TTL_MS } from '../src/main/vault/merge'
import type { Entry } from '../src/shared/types'

const e = (id: string, updatedAt: number, password = 'p'): Entry => ({
  id,
  type: 'login',
  title: id,
  username: '',
  password,
  urls: [],
  notes: '',
  totp: '',
  tags: [],
  favorite: false,
  createdAt: 0,
  updatedAt,
  trashedAt: null,
  passwordHistory: []
})
const NOW = 1_000_000

describe('mergeVaults', () => {
  it('adds new entries', () => {
    const r = mergeVaults({ entries: [e('a', 1)], tombstones: [] }, { entries: [e('b', 1)], tombstones: [] }, NOW)
    expect(r.entries.map((x) => x.id).sort()).toEqual(['a', 'b'])
    expect(r.stats.added).toBe(1)
  })

  it('newer edit wins on either side', () => {
    const r1 = mergeVaults({ entries: [e('a', 1, 'old')], tombstones: [] }, { entries: [e('a', 2, 'new')], tombstones: [] }, NOW)
    expect(r1.entries[0].password).toBe('new')
    expect(r1.stats.updated).toBe(1)
    const r2 = mergeVaults({ entries: [e('a', 5, 'local')], tombstones: [] }, { entries: [e('a', 2, 'stale')], tombstones: [] }, NOW)
    expect(r2.entries[0].password).toBe('local')
    expect(r2.stats.unchanged).toBe(1)
  })

  it('tombstones delete older entries', () => {
    const r = mergeVaults({ entries: [e('a', 1)], tombstones: [] }, { entries: [], tombstones: [{ id: 'a', deletedAt: 2 }] }, NOW)
    expect(r.entries).toHaveLength(0)
    expect(r.tombstones).toEqual([{ id: 'a', deletedAt: 2 }])
    expect(r.stats.removed).toBe(1)
  })

  it('an edit made after the deletion survives', () => {
    const r = mergeVaults({ entries: [e('a', 10)], tombstones: [] }, { entries: [], tombstones: [{ id: 'a', deletedAt: 5 }] }, NOW)
    expect(r.entries).toHaveLength(1)
    expect(r.tombstones).toHaveLength(0)
  })

  it('does not resurrect locally deleted entries', () => {
    const r = mergeVaults({ entries: [], tombstones: [{ id: 'a', deletedAt: 5 }] }, { entries: [e('a', 3)], tombstones: [] }, NOW)
    expect(r.entries).toHaveLength(0)
  })

  it('is idempotent', () => {
    const local = { entries: [e('a', 1), e('b', 2)], tombstones: [] }
    const incoming = { entries: [e('c', 3)], tombstones: [{ id: 'b', deletedAt: 4 }] }
    const once = mergeVaults(local, incoming, NOW)
    const twice = mergeVaults(once, incoming, NOW)
    expect(twice.entries.map((x) => x.id).sort()).toEqual(['a', 'c'])
    expect(twice.stats.added + twice.stats.updated + twice.stats.removed).toBe(0)
  })

  it('purges expired tombstones', () => {
    const r = mergeVaults({ entries: [], tombstones: [{ id: 'old', deletedAt: 0 }] }, { entries: [], tombstones: [] }, TOMBSTONE_TTL_MS + 10)
    expect(r.tombstones).toHaveLength(0)
  })
})
