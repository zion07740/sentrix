import { describe, expect, it } from 'vitest'
import { buildHealthReport } from '../src/main/health'
import type { Entry } from '../src/shared/types'

const NOW = Date.UTC(2026, 10, 11)
const DAY = 86_400_000
let n = 0
const login = (p: Partial<Entry>): Entry => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  type: 'login',
  title: 'Site',
  username: 'me',
  password: `Xq7!vR2#pLm9@tZ4-${n}`,
  urls: ['https://site.example.com'],
  notes: '',
  totp: 'JBSWY3DPEHPK3PXP',
  tags: [],
  favorite: false,
  createdAt: NOW - 10 * DAY,
  updatedAt: NOW - 10 * DAY,
  trashedAt: null,
  passwordHistory: [],
  ...p
})

describe('buildHealthReport', () => {
  it('reports a healthy vault as 100', () => {
    const r = buildHealthReport([login({}), login({ password: 'Gh9$kQ2!zWm4#Lp8' })], NOW)
    expect(r.score).toBe(100)
    expect(r.items).toHaveLength(0)
  })

  it('flags weak and empty passwords', () => {
    const weak = login({ password: 'password1' })
    const empty = login({ password: '' })
    const r = buildHealthReport([weak, empty, login({})], NOW)
    expect(r.counts.weak).toBe(2)
    expect(r.items.find((i) => i.id === weak.id)?.issues).toContain('weak')
  })

  it('groups reused passwords', () => {
    const a = login({ password: 'Same-Strong-Pw!93kx' })
    const b = login({ password: 'Same-Strong-Pw!93kx' })
    const c = login({ password: 'Same-Strong-Pw!93kx' })
    const r = buildHealthReport([a, b, c, login({})], NOW)
    expect(r.counts.reused).toBe(3)
    expect(r.items.find((i) => i.id === a.id)?.reusedCount).toBe(2)
  })

  it('flags old passwords using the last change date', () => {
    const old = login({ createdAt: NOW - 400 * DAY })
    const changed = login({ createdAt: NOW - 400 * DAY, passwordHistory: [{ password: 'x', changedAt: NOW - 5 * DAY }] })
    const r = buildHealthReport([old, changed], NOW)
    expect(r.items.find((i) => i.id === old.id)?.issues).toContain('old')
    expect(r.items.find((i) => i.id === changed.id)).toBeUndefined()
  })

  it('flags http on public sites but not on local addresses', () => {
    const pub = login({ urls: ['http://shop.example.com'] })
    const local = login({ urls: ['http://192.168.1.1', 'http://localhost:3000'] })
    const r = buildHealthReport([pub, local], NOW)
    expect(r.counts.insecure).toBe(1)
    expect(r.items.find((i) => i.id === pub.id)?.issues).toContain('insecure')
  })

  it('counts missing 2FA without lowering the score', () => {
    const r = buildHealthReport([login({ totp: '' })], NOW)
    expect(r.counts.no2fa).toBe(1)
    expect(r.score).toBe(100)
  })

  it('ignores trashed items and notes', () => {
    const r = buildHealthReport([login({ password: '123', trashedAt: NOW }), login({ type: 'note', password: '' })], NOW)
    expect(r.total).toBe(0)
    expect(r.score).toBe(100)
  })

  it('computes the score from logins without weak/reused/insecure problems', () => {
    const r = buildHealthReport([login({}), login({ password: 'abc' }), login({ urls: ['http://a.example.org'] }), login({})], NOW)
    expect(r.score).toBe(50)
  })

  it('never includes passwords in the report', () => {
    const secret = 'Leak-Check-Pw!8842'
    const r = buildHealthReport([login({ password: secret }), login({ password: secret })], NOW)
    expect(JSON.stringify(r)).not.toContain(secret)
  })
})
