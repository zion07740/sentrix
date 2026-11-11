import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HEADER_LEN } from '../src/main/vault/format'
import { VaultStore, parseExportJson } from '../src/main/vault/store'
import { applyInput } from '../src/main/vault/entry'
import type { KdfParams } from '../src/main/vault/crypto'

const FAST: KdfParams = { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 }
const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sentrix-rec-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})
const note = (text: string) => applyInput({ type: 'note', title: text, username: '', password: '', urls: [], notes: text, totp: '', tags: [], favorite: false }, undefined)

async function vaultWithTwoSaves(dir: string) {
  const store = new VaultStore(dir, FAST)
  await store.create('master-password-1')
  store.vault.entries.push(note('first'))
  store.save() // .bak now = empty vault, main = [first]
  store.vault.entries.push(note('second'))
  store.save() // .bak = [first], main = [first, second]
  store.lock()
  return store
}

describe('damaged vault recovery', () => {
  it('opens the backup when the main file is damaged, and restores the main file', async () => {
    const dir = tmp()
    const store = await vaultWithTwoSaves(dir)
    const file = readFileSync(store.path)
    file[HEADER_LEN + 5] ^= 0xff // corrupt the encrypted payload
    writeFileSync(store.path, file)

    expect(await store.unlock('master-password-1')).toBe(true)
    expect(store.lastRecovery).toMatch(/damaged/)
    expect(store.vault.entries.map((e) => e.title)).toEqual(['first'])
    expect(readdirSync(dir).some((f) => f.startsWith('vault.sentrix.damaged-'))).toBe(true)

    store.lock()
    expect(await store.unlock('master-password-1')).toBe(true) // main file works again
    expect(store.lastRecovery).toBeNull()
  })

  it('does not fall back on a wrong password (no silent rollback after a password change)', async () => {
    const dir = tmp()
    const store = new VaultStore(dir, FAST)
    await store.create('old-password-1')
    store.vault.entries.push(note('before change'))
    store.save()
    await store.changePassword('old-password-1', 'new-password-1') // .bak still opens with old password
    store.vault.entries.push(note('after change'))
    store.save()
    store.lock()
    expect(await store.unlock('old-password-1')).toBe(false)
    expect(existsSync(store.path)).toBe(true)
    expect(await store.unlock('new-password-1')).toBe(true)
    expect(store.vault.entries).toHaveLength(2)
  })

  it('reports damage when there is no usable backup', async () => {
    const dir = tmp()
    const store = new VaultStore(dir, FAST)
    await store.create('master-password-1')
    store.lock()
    const file = readFileSync(store.path)
    file[HEADER_LEN + 2] ^= 1
    writeFileSync(store.path, file)
    await expect(store.unlock('master-password-1')).rejects.toThrow(/damaged|tampered/)
  })
})

describe('import timestamp clamp', () => {
  it('pulls far-future timestamps back to now', () => {
    const e = note('x')
    const future = Date.now() + 365 * 86_400_000
    const data = parseExportJson(Buffer.from(JSON.stringify({ entries: [{ ...e, updatedAt: future, createdAt: future }], tombstones: [{ id: e.id, deletedAt: future }] })))
    expect(data.entries[0].updatedAt).toBeLessThanOrEqual(Date.now())
    expect(data.tombstones[0].deletedAt).toBeLessThanOrEqual(Date.now())
  })

  it('keeps normal timestamps (small clock skew allowed)', () => {
    const e = note('y')
    const soon = Date.now() + 60_000
    const data = parseExportJson(Buffer.from(JSON.stringify({ entries: [{ ...e, updatedAt: soon }] })))
    expect(data.entries[0].updatedAt).toBe(soon)
  })
})
