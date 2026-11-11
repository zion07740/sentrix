import { EventEmitter } from 'node:events'
import { clipboard, ClipboardItem } from 'electron'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { UnlockThrottle, VaultStore } from './vault/store'

const osFormat = (name: string) => `electron application/osclipboard;format="${name}"`

/**
 * Copy a secret and ask Windows not to keep it: these formats stop it from being saved in
 * clipboard history (Win+V), synced to the cloud clipboard, or recorded by clipboard monitors.
 */
async function writeSecretToClipboard(value: string): Promise<void> {
  if (process.platform === 'win32') {
    try {
      const zeroDword = new Blob([new Uint8Array(4)])
      await clipboard.write([
        new ClipboardItem({
          'text/plain': value,
          [osFormat('ExcludeClipboardContentFromMonitorProcessing')]: new Blob([new Uint8Array(1)]),
          [osFormat('CanIncludeInClipboardHistory')]: zeroDword,
          [osFormat('CanUploadToCloudClipboard')]: zeroDword
        })
      ])
      return
    } catch (e) {
      console.warn('[sentrix] clipboard privacy formats not supported, copying plain text:', (e as Error).message)
    }
  }
  await clipboard.writeText(value)
}

/**
 * Holds the unlocked vault for the lifetime of the app and owns everything that
 * must be wiped when it locks: the key, the decrypted data and the clipboard.
 */
export class Session extends EventEmitter {
  readonly throttle = new UnlockThrottle()
  private lastActivity = Date.now()
  private idleTimer: NodeJS.Timeout | null = null
  private clipboardTimer: NodeJS.Timeout | null = null
  private clipboardValue: string | null = null

  constructor(readonly store: VaultStore) {
    super()
  }

  get unlocked(): boolean {
    return this.store.unlocked
  }

  get settings(): Settings {
    return this.store.unlocked ? this.store.vault.settings : DEFAULT_SETTINGS
  }

  /** Called on any user-driven action; postpones auto-lock. */
  touch(): void {
    this.lastActivity = Date.now()
  }

  onUnlocked(): void {
    this.throttle.reset()
    this.touch()
    this.startIdleWatch()
    this.emit('unlocked')
  }

  lock(): void {
    const was = this.store.unlocked
    this.store.lock()
    this.stopIdleWatch()
    this.clearClipboardNow()
    if (was) this.emit('locked')
  }

  /** Persist and notify the UI that data changed. */
  commit(): void {
    this.store.save()
    this.emit('vault-changed')
  }

  async copySecret(value: string): Promise<void> {
    await writeSecretToClipboard(value)
    this.clipboardValue = value
    if (this.clipboardTimer) clearTimeout(this.clipboardTimer)
    const secs = this.settings.clipboardClearSeconds
    if (secs > 0) this.clipboardTimer = setTimeout(() => this.clearClipboardNow(), secs * 1000)
  }

  /** Clears the clipboard only if it still holds what we put there. */
  clearClipboardNow(): void {
    if (this.clipboardTimer) clearTimeout(this.clipboardTimer)
    this.clipboardTimer = null
    const value = this.clipboardValue
    this.clipboardValue = null
    if (value === null) return
    clipboard
      .readText()
      .then((current) => {
        if (current === value) clipboard.clear()
      })
      .catch(() => clipboard.clear())
  }

  private startIdleWatch(): void {
    this.stopIdleWatch()
    this.idleTimer = setInterval(() => {
      const minutes = this.settings.autoLockMinutes
      if (minutes > 0 && Date.now() - this.lastActivity >= minutes * 60_000) this.lock()
    }, 5_000)
  }

  private stopIdleWatch(): void {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
  }
}
