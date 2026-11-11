// Types shared by the main process, the preload bridge and the React UI.

export const APP_NAME = 'Sentrix'

export type EntryType = 'login' | 'note'

export interface PasswordHistoryItem {
  password: string
  changedAt: number
}

export interface Entry {
  id: string
  type: EntryType
  title: string
  username: string
  password: string
  urls: string[]
  notes: string
  totp: string
  tags: string[]
  favorite: boolean
  createdAt: number
  updatedAt: number
  /** Set when the entry is in the trash. */
  trashedAt: number | null
  passwordHistory: PasswordHistoryItem[]
}

/** Record of a permanently deleted entry, so deletions survive export/import merges. */
export interface Tombstone {
  id: string
  deletedAt: number
}

export interface PairedBrowser {
  clientId: string
  name: string
  /** base64 AES-256 key shared with the extension */
  key: string
  createdAt: number
  lastUsedAt: number
}

export interface Settings {
  autoLockMinutes: number
  clipboardClearSeconds: number
  browserIntegration: boolean
  lockOnMinimize: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  autoLockMinutes: 5,
  clipboardClearSeconds: 30,
  browserIntegration: true,
  lockOnMinimize: false
}

export interface VaultData {
  version: 1
  entries: Entry[]
  tombstones: Tombstone[]
  settings: Settings
  pairings: PairedBrowser[]
}

/** Content of an export file: only entries and tombstones travel between devices. */
export interface ExportData {
  version: 1
  exportedAt: number
  entries: Entry[]
  tombstones: Tombstone[]
}

/** What the list view needs — no secrets. */
export interface EntrySummary {
  id: string
  type: EntryType
  title: string
  username: string
  host: string
  favorite: boolean
  hasTotp: boolean
  tags: string[]
  updatedAt: number
  trashedAt: number | null
}

export type EntryInput = Omit<Entry, 'id' | 'createdAt' | 'updatedAt' | 'trashedAt' | 'passwordHistory'> & {
  id?: string
}

export interface MergeStats {
  added: number
  updated: number
  removed: number
  unchanged: number
}

export interface AppState {
  vaultExists: boolean
  unlocked: boolean
  vaultPath: string
}

export interface UnlockResult {
  ok: boolean
  error?: string
  /** ms the user must wait before trying again (brute-force throttle) */
  retryInMs?: number
}

export interface GeneratorOptions {
  length: number
  lowercase: boolean
  uppercase: boolean
  digits: boolean
  symbols: boolean
  excludeAmbiguous: boolean
}

export interface PassphraseOptions {
  words: number
  separator: string
  capitalize: boolean
  includeNumber: boolean
}

export interface TotpCode {
  code: string
  remaining: number
  period: number
}

export interface PairRequest {
  clientId: string
  name: string
}

export type CopyField = 'username' | 'password' | 'totp'

// ---------------- password health ----------------

export type HealthIssue = 'weak' | 'reused' | 'old' | 'insecure' | 'no2fa'

export interface HealthItem {
  id: string
  title: string
  username: string
  host: string
  issues: HealthIssue[]
  /** zxcvbn score 0–4 */
  strength: number
  /** how many other logins use the same password */
  reusedCount: number
  /** days since the password was last changed */
  ageDays: number
}

export interface HealthReport {
  /** 0–100: share of logins without weak / reused / insecure problems */
  score: number
  total: number
  counts: Record<HealthIssue, number>
  /** only logins with at least one issue */
  items: HealthItem[]
}

// ---------------- Windows Hello ----------------

export interface HelloStatus {
  /** Windows Hello is set up on this PC */
  supported: boolean
  /** Sentrix has a Hello key for this vault */
  enabled: boolean
}

/** API exposed on window.sentrix by the preload script. */
export interface SentrixApi {
  app: {
    state(): Promise<AppState>
    openExternal(url: string): Promise<void>
    activity(): Promise<void>
  }
  vault: {
    create(password: string): Promise<UnlockResult>
    unlock(password: string): Promise<UnlockResult>
    lock(): Promise<void>
    changePassword(current: string, next: string): Promise<UnlockResult>
    list(): Promise<EntrySummary[]>
    get(id: string): Promise<Entry | null>
    save(entry: EntryInput): Promise<Entry>
    trash(id: string): Promise<void>
    restore(id: string): Promise<void>
    deleteForever(id: string): Promise<void>
    emptyTrash(): Promise<number>
    totp(id: string): Promise<TotpCode | null>
    health(): Promise<HealthReport>
    unlockWithHello(): Promise<UnlockResult>
  }
  hello: {
    status(): Promise<HelloStatus>
    enable(masterPassword: string): Promise<{ ok: boolean; error?: string }>
    disable(): Promise<void>
  }
  clipboard: {
    copyField(id: string, field: CopyField): Promise<boolean>
    copyText(text: string): Promise<void>
  }
  generator: {
    password(opts: GeneratorOptions): Promise<string>
    passphrase(opts: PassphraseOptions): Promise<string>
  }
  transfer: {
    exportEncrypted(exportPassword: string): Promise<{ ok: boolean; path?: string; count?: number }>
    pickImportFile(): Promise<{ token: string; name: string; kind: 'sentrix' | 'csv' } | null>
    importEncrypted(token: string, exportPassword: string): Promise<{ ok: boolean; error?: string; stats?: MergeStats }>
    importCsv(token: string): Promise<{ ok: boolean; error?: string; stats?: MergeStats }>
    exportCsv(): Promise<{ ok: boolean; path?: string; count?: number }>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  browser: {
    list(): Promise<Array<Omit<PairedBrowser, 'key'>>>
    revoke(clientId: string): Promise<void>
    approve(clientId: string, code: string): Promise<{ ok: boolean; error?: string }>
    deny(clientId: string): Promise<void>
    extensionId(): Promise<string>
    status(): Promise<{ running: boolean; error: string | null }>
    openExtensionFolder(): Promise<{ ok: boolean; path?: string; error?: string }>
  }
  on(event: 'locked' | 'vault-changed', cb: () => void): () => void
  onPairRequest(cb: (req: PairRequest) => void): () => void
}
