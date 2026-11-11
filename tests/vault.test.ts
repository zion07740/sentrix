import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileKind, HEADER_LEN, createKeyMaterial, openWithPassword, writeEncrypted } from '../src/main/vault/format'
import { VaultStore, UnlockThrottle } from '../src/main/vault/store'
import { applyInput } from '../src/main/vault/entry'
import type { KdfParams } from '../src/main/vault/crypto'

// Smallest parameters the reader accepts, to keep tests fast.
const FAST: KdfParams = { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 }

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sentrix-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const login = (title: string, password: string) =>
  applyInput({ type: 'login', title, username: 'me', password, urls: [], notes: '', totp: '', tags: [], favorite: false }, undefined)

describe('file format', () => {
  it('round-trips with the right password', async () => {
    const km = await createKeyMaterial(FileKind.Vault, 'correct horse', FAST)
    const file = writeEncrypted(km, Buffer.from('hello secrets'))
    const { plaintext } = await openWithPassword(file, FileKind.Vault, 'correct horse')
    expect(plaintext.toString()).toBe('hello secrets')
  })

  it('does not contain the plaintext', async () => {
    const km = await createKeyMaterial(FileKind.Vault, 'pw-12345678', FAST)
    const file = writeEncrypted(km, Buffer.from('SUPERSECRETVALUE'))
    expect(file.includes(Buffer.from('SUPERSECRETVALUE'))).toBe(false)
  })

  it('rejects a wrong password', async () => {
    const km = await createKeyMaterial(FileKind.Vault, 'right-password', FAST)
    const file = writeEncrypted(km, Buffer.from('x'))
    await expect(openWithPassword(file, FileKind.Vault, 'wrong-password')).rejects.toThrow(/Wrong password/)
  })

  it('detects tampering anywhere in the file', async () => {
    const km = await createKeyMaterial(FileKind.Vault, 'pw-12345678', FAST)
    const file = writeEncrypted(km, Buffer.from('some data that matters'))
    // salt, wrap nonce, wrapped key, data nonce, ciphertext, tag
    for (const offset of [20, 35, 60, 95, HEADER_LEN + 2, file.length - 1]) {
      const bad = Buffer.from(file)
      bad[offset] ^= 0x01
      await expect(openWithPassword(bad, FileKind.Vault, 'pw-12345678')).rejects.toThrow()
    }
  })

  it('uses a fresh nonce on every save', async () => {
    const km = await createKeyMaterial(FileKind.Vault, 'pw-12345678', FAST)
    const a = writeEncrypted(km, Buffer.from('same'))
    const b = writeEncrypted(km, Buffer.from('same'))
    expect(a.equals(b)).toBe(false)
  })

  it('refuses to open an export as a vault', async () => {
    const km = await createKeyMaterial(FileKind.Export, 'pw-12345678', FAST)
    const file = writeEncrypted(km, Buffer.from('{}'))
    await expect(openWithPassword(file, FileKind.Vault, 'pw-12345678')).rejects.toThrow(/export file/)
  })

  it('rejects hostile KDF parameters', async () => {
    const km = await createKeyMaterial(FileKind.Vault, 'pw-12345678', FAST)
    const file = writeEncrypted(km, Buffer.from('x'))
    file.writeUInt32BE(0xffffffff, 6) // absurd memory cost
    await expect(openWithPassword(file, FileKind.Vault, 'pw-12345678')).rejects.toThrow(/key-derivation/)
  })
})

describe('VaultStore', () => {
  it('creates, saves, locks and unlocks', async () => {
    const store = new VaultStore(tmp(), FAST)
    await store.create('master-password-1')
    store.vault.entries.push(login('Mail', 'p@ss-unique-value'))
    store.save()
    store.lock()
    expect(store.unlocked).toBe(false)
    expect(await store.unlock('nope-nope-nope')).toBe(false)
    expect(await store.unlock('master-password-1')).toBe(true)
    expect(store.vault.entries[0].password).toBe('p@ss-unique-value')
    expect(readFileSync(store.path).includes(Buffer.from('p@ss-unique-value'))).toBe(false)
  })

  it('changes the master password and keeps data', async () => {
    const store = new VaultStore(tmp(), FAST)
    await store.create('old-password-1')
    store.vault.entries.push(login('n', 'keep me'))
    store.save()
    expect(await store.changePassword('wrong-current', 'new-password-1')).toBe(false)
    expect(await store.changePassword('old-password-1', 'new-password-1')).toBe(true)
    store.lock()
    expect(await store.unlock('old-password-1')).toBe(false)
    expect(await store.unlock('new-password-1')).toBe(true)
    expect(store.vault.entries[0].password).toBe('keep me')
  })

  it('exports and imports into another device', async () => {
    const a = new VaultStore(tmp(), FAST)
    await a.create('device-a-password')
    a.vault.entries.push(login('Bank', 'secret'))
    a.save()
    const { file, count } = await a.exportEncrypted('transfer-pass')
    expect(count).toBe(1)
    const exportPath = join(tmp(), 'x.sentrix-export')
    writeFileSync(exportPath, file)

    const b = new VaultStore(tmp(), FAST)
    await b.create('device-b-password')
    expect(await VaultStore.readExport(readFileSync(exportPath), 'wrong')).toBeNull()
    const data = await VaultStore.readExport(readFileSync(exportPath), 'transfer-pass')
    const stats = b.mergeIn(data!)
    expect(stats.added).toBe(1)
    expect(b.vault.entries[0].password).toBe('secret')
  })

  it('rejects short master passwords', async () => {
    await expect(new VaultStore(tmp(), FAST).create('short')).rejects.toThrow(/at least/)
  })

  it('keeps password history on change', () => {
    const first = login('x', 'one')
    const second = applyInput({ ...first, password: 'two' }, first)
    expect(second.password).toBe('two')
    expect(second.passwordHistory[0].password).toBe('one')
    expect(second.id).toBe(first.id)
  })
})

describe('UnlockThrottle', () => {
  it('delays after repeated failures', () => {
    const t = new UnlockThrottle()
    t.fail(0)
    t.fail(0)
    expect(t.check(0)).toBe(0)
    t.fail(0)
    expect(t.check(0)).toBe(1000)
    t.fail(0)
    expect(t.check(0)).toBe(2000)
    t.reset()
    expect(t.check(0)).toBe(0)
  })
})
