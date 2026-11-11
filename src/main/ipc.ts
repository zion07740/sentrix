import { randomBytes } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, type BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, shell } from 'electron'
import type { CopyField, EntryInput, GeneratorOptions, PassphraseOptions, Settings, UnlockResult } from '@shared/types'
import type { Session } from './session'
import { applyInput, summarize } from './vault/entry'
import { MIN_MASTER_LENGTH, VaultStore } from './vault/store'
import { entriesFromCsv, entriesToCsv } from './vault/csv'
import { generatePassphrase, generatePassword } from './generator'
import { totpNow } from './totp'
import type { BridgeServer } from './bridge/server'
import { EXTENSION_ID } from './bridge/constants'
import { CryptoError } from './vault/crypto'

const MAX_IMPORT_BYTES = 50 * 1024 * 1024

export function registerIpc(opts: {
  session: Session
  bridge: BridgeServer
  window: () => BrowserWindow | null
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean
}): void {
  const { session, bridge, isTrustedSender } = opts
  const store = session.store
  const importTokens = new Map<string, string>()

  /** Wraps a handler: rejects calls from anything but our own UI and counts as user activity. */
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>, needsUnlock = true) => {
    ipcMain.handle(channel, async (e, ...args) => {
      if (!isTrustedSender(e)) throw new Error('Untrusted sender')
      if (needsUnlock && !session.unlocked) throw new Error('Vault is locked')
      session.touch()
      return fn(...(args as A))
    })
  }

  const str = (v: unknown, max = 10_000): string => {
    if (typeof v !== 'string' || v.length > max) throw new Error('Invalid argument')
    return v
  }

  const findEntry = (id: string) => store.vault.entries.find((e) => e.id === id)

  // ---------------- app ----------------
  handle('app:state', () => ({ vaultExists: store.exists(), unlocked: session.unlocked, vaultPath: store.path }), false)
  handle('app:activity', () => undefined, false)
  handle(
    'app:openExternal',
    async (url: string) => {
      const u = new URL(str(url, 4096))
      if (u.protocol === 'https:' || u.protocol === 'http:') await shell.openExternal(u.toString())
    },
    false
  )

  // ---------------- vault lifecycle ----------------
  const unlockLike = async (fn: () => Promise<boolean>): Promise<UnlockResult> => {
    const wait = session.throttle.check()
    if (wait > 0) return { ok: false, error: 'Too many attempts. Please wait.', retryInMs: wait }
    try {
      const ok = await fn()
      if (!ok) {
        session.throttle.fail()
        return { ok: false, error: 'Wrong master password', retryInMs: session.throttle.check() }
      }
      session.onUnlocked()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof CryptoError ? `Vault file problem: ${e.message}` : (e as Error).message }
    }
  }

  handle(
    'vault:create',
    async (password: string) => {
      const pw = str(password, 1024)
      if (pw.length < MIN_MASTER_LENGTH) return { ok: false, error: `Use at least ${MIN_MASTER_LENGTH} characters` }
      return unlockLike(async () => {
        await store.create(pw)
        return true
      })
    },
    false
  )
  handle('vault:unlock', (password: string) => unlockLike(() => store.unlock(str(password, 1024))), false)
  handle('vault:lock', () => session.lock(), false)
  handle('vault:changePassword', async (current: string, next: string): Promise<UnlockResult> => {
    const wait = session.throttle.check()
    if (wait > 0) return { ok: false, error: 'Too many attempts. Please wait.', retryInMs: wait }
    try {
      const ok = await store.changePassword(str(current, 1024), str(next, 1024))
      if (!ok) {
        session.throttle.fail()
        return { ok: false, error: 'Current master password is wrong' }
      }
      session.throttle.reset()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ---------------- entries ----------------
  handle('vault:list', () => store.vault.entries.map(summarize))
  handle('vault:get', (id: string) => findEntry(str(id, 64)) ?? null)
  handle('vault:save', (input: EntryInput) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid entry')
    const existing = typeof input.id === 'string' ? findEntry(input.id) : undefined
    const next = applyInput(input, existing)
    const v = store.vault
    v.entries = existing ? v.entries.map((e) => (e.id === next.id ? next : e)) : [...v.entries, next]
    session.commit()
    return next
  })
  const setTrashed = (id: string, trashed: boolean) => {
    const e = findEntry(str(id, 64))
    if (!e) return
    e.trashedAt = trashed ? Date.now() : null
    e.updatedAt = Date.now()
    session.commit()
  }
  handle('vault:trash', (id: string) => setTrashed(id, true))
  handle('vault:restore', (id: string) => setTrashed(id, false))
  const deleteForever = (ids: string[]) => {
    const v = store.vault
    const now = Date.now()
    const set = new Set(ids)
    v.entries = v.entries.filter((e) => !set.has(e.id))
    v.tombstones = [...v.tombstones.filter((t) => !set.has(t.id)), ...ids.map((id) => ({ id, deletedAt: now }))]
    session.commit()
  }
  handle('vault:deleteForever', (id: string) => deleteForever([str(id, 64)]))
  handle('vault:emptyTrash', () => {
    const ids = store.vault.entries.filter((e) => e.trashedAt !== null).map((e) => e.id)
    if (ids.length) deleteForever(ids)
    return ids.length
  })
  handle('vault:totp', (id: string) => {
    const e = findEntry(str(id, 64))
    return e?.totp ? totpNow(e.totp) : null
  })

  // ---------------- clipboard ----------------
  handle('clipboard:copyField', async (id: string, field: CopyField) => {
    const e = findEntry(str(id, 64))
    if (!e) return false
    const value = field === 'username' ? e.username : field === 'password' ? e.password : field === 'totp' ? totpNow(e.totp)?.code ?? '' : ''
    if (!value) return false
    await session.copySecret(value)
    return true
  })
  handle('clipboard:copyText', (text: string) => session.copySecret(str(text, 10_000)), false)

  // ---------------- generator ----------------
  handle('gen:password', (o: GeneratorOptions) => generatePassword(o ?? ({} as GeneratorOptions)), false)
  handle('gen:passphrase', (o: PassphraseOptions) => generatePassphrase(o ?? ({} as PassphraseOptions)), false)

  // ---------------- export / import ----------------
  const stamp = () => new Date().toISOString().slice(0, 10)

  handle('transfer:exportEncrypted', async (exportPassword: string) => {
    const pw = str(exportPassword, 1024)
    if (pw.length < MIN_MASTER_LENGTH) throw new Error(`Export password must be at least ${MIN_MASTER_LENGTH} characters`)
    const win = opts.window()
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export Sentrix vault',
      defaultPath: `Sentrix-export-${stamp()}.sentrix-export`,
      filters: [{ name: 'Sentrix export', extensions: ['sentrix-export'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false }
    const { file, count } = await store.exportEncrypted(pw)
    writeFileSync(res.filePath, file, { mode: 0o600 })
    return { ok: true, path: res.filePath, count }
  })

  handle('transfer:pickImportFile', async () => {
    const res = await dialog.showOpenDialog(opts.window()!, {
      title: 'Import into Sentrix',
      properties: ['openFile'],
      filters: [
        { name: 'Sentrix export or CSV', extensions: ['sentrix-export', 'csv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const path = res.filePaths[0]
    if (statSync(path).size > MAX_IMPORT_BYTES) throw new Error('File is too large')
    const token = randomBytes(16).toString('hex')
    importTokens.set(token, path)
    const head = readFileSync(path).subarray(0, 4).toString('ascii')
    return { token, name: basename(path), kind: head === 'SNTX' ? 'sentrix' : 'csv' }
  })

  handle('transfer:importEncrypted', async (token: string, exportPassword: string) => {
    const path = importTokens.get(str(token, 64))
    if (!path) return { ok: false, error: 'Pick the file again' }
    try {
      const data = await VaultStore.readExport(readFileSync(path), str(exportPassword, 1024))
      if (!data) return { ok: false, error: 'Wrong export password' }
      importTokens.delete(token)
      const stats = store.mergeIn(data)
      session.commit()
      return { ok: true, stats }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  handle('transfer:importCsv', (token: string) => {
    const path = importTokens.get(str(token, 64))
    if (!path) return { ok: false, error: 'Pick the file again' }
    importTokens.delete(token)
    try {
      const entries = entriesFromCsv(readFileSync(path, 'utf8'))
      const stats = store.mergeIn({ entries, tombstones: [] })
      session.commit()
      return { ok: true, stats }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  handle('transfer:exportCsv', async () => {
    const res = await dialog.showSaveDialog(opts.window()!, {
      title: 'Export UNENCRYPTED CSV',
      defaultPath: `Sentrix-UNENCRYPTED-${stamp()}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false }
    const entries = store.vault.entries.filter((e) => e.trashedAt === null)
    writeFileSync(res.filePath, entriesToCsv(entries), { mode: 0o600 })
    return { ok: true, path: res.filePath, count: entries.length }
  })

  // ---------------- settings ----------------
  handle('settings:get', () => store.vault.settings)
  handle('settings:set', (patch: Partial<Settings>) => {
    const s = store.vault.settings
    const clampInt = (v: unknown, min: number, max: number, cur: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : cur
    s.autoLockMinutes = clampInt(patch?.autoLockMinutes, 0, 240, s.autoLockMinutes)
    s.clipboardClearSeconds = clampInt(patch?.clipboardClearSeconds, 0, 600, s.clipboardClearSeconds)
    if (typeof patch?.lockOnMinimize === 'boolean') s.lockOnMinimize = patch.lockOnMinimize
    if (typeof patch?.browserIntegration === 'boolean' && patch.browserIntegration !== s.browserIntegration) {
      s.browserIntegration = patch.browserIntegration
      if (s.browserIntegration) bridge.start()
      else bridge.stop()
    }
    session.commit()
    return s
  })

  // ---------------- browser pairing ----------------
  handle('browser:list', () => store.vault.pairings.map(({ key: _key, ...rest }) => rest))
  handle('browser:revoke', (clientId: string) => {
    const v = store.vault
    v.pairings = v.pairings.filter((p) => p.clientId !== str(clientId, 64))
    session.commit()
  })
  handle('browser:approve', (clientId: string, code: string) => bridge.approve(str(clientId, 64), str(code, 20)))
  handle('browser:deny', (clientId: string) => bridge.deny(str(clientId, 64)), false)
  handle('browser:extensionId', () => EXTENSION_ID, false)
  handle('browser:status', () => ({ running: bridge.running, error: bridge.lastError }), false)
  handle(
    'browser:openExtensionFolder',
    async () => {
      const dir = app.isPackaged ? join(process.resourcesPath, 'extension') : join(app.getAppPath(), 'extension')
      const err = await shell.openPath(dir)
      return err ? { ok: false, error: err } : { ok: true, path: dir }
    },
    false
  )
}
