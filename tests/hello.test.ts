import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { newChallenge, parseBlob, unwrapWithHello, wrapForHello } from '../src/main/hello/blob'
import { VaultStore } from '../src/main/vault/store'
import { applyInput } from '../src/main/vault/entry'
import type { KdfParams } from '../src/main/vault/crypto'

const FAST: KdfParams = { memoryKiB: 19 * 1024, iterations: 2, parallelism: 1 }
const NAME = 'Sentrix-0b7e1c2a-5d1f-4a7b-9c3e-2f6a8b9c0d1e'
// Stand-in for a Windows Hello RSA-2048 signature (256 bytes).
const fakeSignature = () => randomBytes(256)

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('Windows Hello key wrapping', () => {
  it('round-trips the vault key with the same signature', () => {
    const vaultKey = randomBytes(32)
    const sig = fakeSignature()
    const blob = wrapForHello(vaultKey, sig, newChallenge(), NAME)
    expect(unwrapWithHello(blob, sig).equals(vaultKey)).toBe(true)
  })

  it('does not store the vault key in the clear', () => {
    const vaultKey = randomBytes(32)
    const blob = wrapForHello(vaultKey, fakeSignature(), newChallenge(), NAME)
    expect(JSON.stringify(blob)).not.toContain(vaultKey.toString('base64'))
  })

  it('rejects a different signature', () => {
    const blob = wrapForHello(randomBytes(32), fakeSignature(), newChallenge(), NAME)
    expect(() => unwrapWithHello(blob, fakeSignature())).toThrow()
  })

  it('rejects a modified blob (name, challenge or ciphertext)', () => {
    const sig = fakeSignature()
    const blob = wrapForHello(randomBytes(32), sig, newChallenge(), NAME)
    expect(() => unwrapWithHello({ ...blob, name: 'Sentrix-11111111-1111-4111-8111-111111111111' }, sig)).toThrow()
    expect(() => unwrapWithHello({ ...blob, challenge: newChallenge().toString('base64') }, sig)).toThrow()
    const ct = Buffer.from(blob.wrapped, 'base64')
    ct[0] ^= 1
    expect(() => unwrapWithHello({ ...blob, wrapped: ct.toString('base64') }, sig)).toThrow()
  })

  it('rejects implausibly short signatures', () => {
    expect(() => wrapForHello(randomBytes(32), randomBytes(16), newChallenge(), NAME)).toThrow()
  })

  it('validates stored blob files', () => {
    const blob = wrapForHello(randomBytes(32), fakeSignature(), newChallenge(), NAME)
    expect(parseBlob(JSON.stringify(blob)).name).toBe(NAME)
    expect(() => parseBlob(JSON.stringify({ ...blob, name: '../evil' }))).toThrow()
    expect(() => parseBlob('{}')).toThrow()
  })
})

describe('unlocking a vault through the Hello path', () => {
  it('opens the vault with the unwrapped key, and the key survives a master password change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentrix-hello-'))
    dirs.push(dir)
    const store = new VaultStore(dir, FAST)
    await store.create('master-password-1')
    store.vault.entries.push(applyInput({ type: 'note', title: 'n', username: '', password: '', urls: [], notes: 'hello works', totp: '', tags: [], favorite: false }, undefined))
    store.save()

    const sig = fakeSignature()
    const key = store.vaultKeyCopy()
    const blob = wrapForHello(key, sig, newChallenge(), NAME)

    expect(await store.changePassword('master-password-1', 'master-password-2')).toBe(true)
    store.lock()

    expect(store.unlockWithVaultKey(unwrapWithHello(blob, sig))).toBe(true)
    expect(store.vault.entries[0].notes).toBe('hello works')
    store.lock()
    expect(store.unlockWithVaultKey(randomBytes(32))).toBe(false)
    expect(store.unlocked).toBe(false)
  })

  it('verifyPassword checks without unlocking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentrix-hello-'))
    dirs.push(dir)
    const store = new VaultStore(dir, FAST)
    await store.create('master-password-1')
    store.lock()
    expect(await store.verifyPassword('nope-nope-nope')).toBe(false)
    expect(await store.verifyPassword('master-password-1')).toBe(true)
    expect(store.unlocked).toBe(false)
  })
})
