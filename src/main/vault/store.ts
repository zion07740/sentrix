import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, copyFileSync, writeSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  type Entry,
  type ExportData,
  type PairedBrowser,
  type Settings,
  type Tombstone,
  type VaultData
} from '@shared/types'
import { type KdfParams, DEFAULT_KDF, wipe } from './crypto'
import {
  FileKind,
  type KeyMaterial,
  WrongPasswordError,
  createKeyMaterial,
  openWithKey,
  openWithPassword,
  parseHeader,
  wrapKey,
  writeEncrypted
} from './format'
import { sanitizeEntry, sanitizeTombstone } from './entry'
import { TOMBSTONE_TTL_MS, mergeVaults } from './merge'

export const VAULT_FILE = 'vault.sentrix'
export const MIN_MASTER_LENGTH = 8

/** Write a file so that a crash can never leave a half-written vault. */
export function atomicWrite(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (existsSync(path)) copyFileSync(path, `${path}.bak`)
  renameSync(tmp, path)
}

function parseVaultJson(plaintext: Buffer): VaultData {
  const raw = JSON.parse(plaintext.toString('utf8')) as Partial<VaultData>
  const settings: Settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) }
  return {
    version: 1,
    entries: (raw.entries ?? []).map((e) => sanitizeEntry(e)).filter((e): e is Entry => !!e),
    tombstones: (raw.tombstones ?? []).map(sanitizeTombstone).filter((t): t is Tombstone => !!t),
    settings,
    pairings: Array.isArray(raw.pairings) ? (raw.pairings as PairedBrowser[]).filter((p) => p && typeof p.clientId === 'string' && typeof p.key === 'string') : []
  }
}

/** Parse and validate the decrypted contents of an export file (untrusted input). */
export function parseExportJson(plaintext: Buffer): ExportData {
  let raw: Partial<ExportData>
  try {
    raw = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new Error('Export file contents are not valid')
  }
  // A timestamp in the future (wrong clock, or a crafted file) would win every later merge,
  // so later edits could never replace it. Clamp anything beyond a day of skew to "now".
  const now = Date.now()
  const limit = now + 24 * 60 * 60 * 1000
  const clamp = (t: number) => (t > limit ? now : t)
  return {
    version: 1,
    exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : 0,
    entries: (Array.isArray(raw.entries) ? raw.entries : [])
      .map((e) => sanitizeEntry(e))
      .filter((e): e is Entry => !!e)
      .map((e) => ({ ...e, createdAt: clamp(e.createdAt), updatedAt: clamp(e.updatedAt), trashedAt: e.trashedAt === null ? null : clamp(e.trashedAt) })),
    tombstones: (Array.isArray(raw.tombstones) ? raw.tombstones : [])
      .map(sanitizeTombstone)
      .filter((t): t is Tombstone => !!t)
      .map((t) => ({ ...t, deletedAt: clamp(t.deletedAt) }))
  }
}

/**
 * Brute-force throttle: after 3 failed attempts, each further attempt must wait
 * 1s, 2s, 4s … up to 30s. Argon2id already makes each guess expensive.
 */
export class UnlockThrottle {
  private failures = 0
  private nextAllowed = 0
  check(now = Date.now()): number {
    return Math.max(0, this.nextAllowed - now)
  }
  fail(now = Date.now()): void {
    this.failures++
    if (this.failures >= 3) this.nextAllowed = now + Math.min(30_000, 1000 * 2 ** (this.failures - 3))
  }
  reset(): void {
    this.failures = 0
    this.nextAllowed = 0
  }
}

export class VaultStore {
  readonly path: string
  private km: KeyMaterial | null = null
  private data: VaultData | null = null

  constructor(
    dir: string,
    private kdf: KdfParams = DEFAULT_KDF
  ) {
    this.path = join(dir, VAULT_FILE)
  }

  exists(): boolean {
    return existsSync(this.path)
  }

  get unlocked(): boolean {
    return this.km !== null && this.data !== null
  }

  /** Throws if locked. */
  get vault(): VaultData {
    if (!this.data) throw new Error('Vault is locked')
    return this.data
  }

  async create(password: string): Promise<void> {
    if (this.exists()) throw new Error('A vault already exists')
    if (password.length < MIN_MASTER_LENGTH) throw new Error(`Master password must be at least ${MIN_MASTER_LENGTH} characters`)
    this.km = await createKeyMaterial(FileKind.Vault, password, this.kdf)
    this.data = { version: 1, entries: [], tombstones: [], settings: { ...DEFAULT_SETTINGS }, pairings: [] }
    this.save()
  }

  /** Set after an unlock that had to fall back to the backup copy; shown to the user once. */
  lastRecovery: string | null = null

  /** Returns false on a wrong password. */
  async unlock(password: string): Promise<boolean> {
    this.lastRecovery = null
    try {
      const { km, plaintext } = await openWithPassword(readFileSync(this.path), FileKind.Vault, password)
      this.load(km, plaintext)
      return true
    } catch (e) {
      if (e instanceof WrongPasswordError) return false
      // The file is damaged (not a wrong password): try the previous copy with the same password.
      // Never fall back on a wrong password: after a password change the .bak opens with the OLD
      // password, and that would silently roll back the latest changes.
      const bak = `${this.path}.bak`
      if (!existsSync(bak)) throw e
      let opened: Awaited<ReturnType<typeof openWithPassword>>
      try {
        opened = await openWithPassword(readFileSync(bak), FileKind.Vault, password)
      } catch {
        throw e
      }
      const damaged = `${this.path}.damaged-${Date.now()}`
      renameSync(this.path, damaged)
      this.load(opened.km, opened.plaintext)
      this.save() // restore the main file from the backup
      this.lastRecovery =
        `Your vault file was damaged, so Sentrix opened the backup copy instead. ` +
        `Changes from your most recent save may be missing. The damaged file was kept as ${basename(damaged)}.`
      return true
    }
  }

  private load(km: KeyMaterial, plaintext: Buffer): void {
    try {
      this.data = parseVaultJson(plaintext)
    } finally {
      wipe(plaintext)
    }
    this.km = km
    this.purgeTombstones()
  }

  /**
   * Unlock with the raw vault key (recovered through Windows Hello). Returns false if the key
   * doesn't open this vault, e.g. the vault was replaced since Hello was set up.
   */
  unlockWithVaultKey(vaultKey: Buffer): boolean {
    const file = readFileSync(this.path)
    const h = parseHeader(file)
    if (h.kind !== FileKind.Vault) return false
    const km: KeyMaterial = { kind: h.kind, kdf: h.kdf, salt: h.salt, wrapNonce: h.wrapNonce, wrappedKey: h.wrappedKey, vaultKey: Buffer.from(vaultKey) }
    let plaintext: Buffer
    try {
      plaintext = openWithKey(file, km)
    } catch {
      wipe(km.vaultKey)
      return false
    }
    try {
      this.data = parseVaultJson(plaintext)
    } finally {
      wipe(plaintext)
    }
    this.km = km
    this.purgeTombstones()
    return true
  }

  /** A copy of the vault key, for wrapping it with Windows Hello. The caller must wipe it. */
  vaultKeyCopy(): Buffer {
    if (!this.km) throw new Error('Vault is locked')
    return Buffer.from(this.km.vaultKey)
  }

  /** Checks a master password against the vault file without changing anything. */
  async verifyPassword(password: string): Promise<boolean> {
    try {
      const { km, plaintext } = await openWithPassword(readFileSync(this.path), FileKind.Vault, password)
      wipe(km.vaultKey, plaintext)
      return true
    } catch (e) {
      if (e instanceof WrongPasswordError) return false
      throw e
    }
  }

  lock(): void {
    if (this.km) wipe(this.km.vaultKey)
    this.km = null
    this.data = null
  }

  save(): void {
    if (!this.km || !this.data) throw new Error('Vault is locked')
    const plaintext = Buffer.from(JSON.stringify(this.data), 'utf8')
    try {
      atomicWrite(this.path, writeEncrypted(this.km, plaintext))
    } finally {
      wipe(plaintext)
    }
  }

  async changePassword(current: string, next: string): Promise<boolean> {
    if (!this.km) throw new Error('Vault is locked')
    if (next.length < MIN_MASTER_LENGTH) throw new Error(`Master password must be at least ${MIN_MASTER_LENGTH} characters`)
    // verify the current password against the file on disk
    const file = readFileSync(this.path)
    try {
      const { km } = await openWithPassword(file, FileKind.Vault, current)
      wipe(km.vaultKey)
    } catch (e) {
      if (e instanceof WrongPasswordError) return false
      throw e
    }
    const old = this.km
    this.km = await wrapKey(FileKind.Vault, next, old.vaultKey, this.kdf)
    wipe(old.vaultKey)
    this.save()
    return true
  }

  // ---------- export / import ----------

  async exportEncrypted(exportPassword: string): Promise<{ file: Buffer; count: number }> {
    const v = this.vault
    const payload: ExportData = { version: 1, exportedAt: Date.now(), entries: v.entries, tombstones: v.tombstones }
    const km = await createKeyMaterial(FileKind.Export, exportPassword, this.kdf)
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
    try {
      return { file: writeEncrypted(km, plaintext), count: v.entries.length }
    } finally {
      wipe(plaintext, km.vaultKey)
    }
  }

  /** Returns null on wrong password. */
  static async readExport(file: Buffer, exportPassword: string): Promise<ExportData | null> {
    try {
      const { km, plaintext } = await openWithPassword(file, FileKind.Export, exportPassword)
      wipe(km.vaultKey)
      try {
        return parseExportJson(plaintext)
      } finally {
        wipe(plaintext)
      }
    } catch (e) {
      if (e instanceof WrongPasswordError) return null
      throw e
    }
  }

  mergeIn(incoming: { entries: Entry[]; tombstones: Tombstone[] }) {
    const v = this.vault
    const { entries, tombstones, stats } = mergeVaults(v, incoming)
    v.entries = entries
    v.tombstones = tombstones
    this.save()
    return stats
  }

  private purgeTombstones(now = Date.now()): void {
    if (!this.data) return
    this.data.tombstones = this.data.tombstones.filter((t) => now - t.deletedAt <= TOMBSTONE_TTL_MS)
  }

  /** Delete the vault file (used by tests). */
  destroy(): void {
    this.lock()
    for (const p of [this.path, `${this.path}.bak`]) if (existsSync(p)) unlinkSync(p)
  }
}
