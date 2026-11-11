import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import script from './hello.ps1?raw'
import { atomicWrite } from '../vault/store'
import { type HelloBlob, newChallenge, parseBlob } from './blob'

export const HELLO_FILE = 'hello.sentrix'

interface HelloResult {
  ok: boolean
  status?: string
  message?: string
  supported?: boolean
  signature?: string
}

/**
 * Runs the Windows Hello helper. The script goes to PowerShell on stdin (no script file on
 * disk, no execution-policy override); arguments go in environment variables.
 */
/**
 * Full path to Windows PowerShell. Never spawn it by bare name: Windows may look in the
 * current/app folder first, so a planted powershell.exe (e.g. next to a portable exe in
 * Downloads) could fake Hello signatures.
 */
export function powershellPath(): string {
  const root = process.env.SystemRoot && /^[A-Za-z]:\\[^"<>|?*]*$/.test(process.env.SystemRoot) ? process.env.SystemRoot : 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function runHello(cmd: 'supported' | 'enroll' | 'sign' | 'remove', name = '', challenge = ''): Promise<HelloResult> {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, status: 'NotSupported' })
  const exe = powershellPath()
  if (!existsSync(exe)) return Promise.resolve({ ok: false, status: 'NotSupported', message: 'Windows PowerShell was not found.' })
  return new Promise((resolve) => {
    const ps = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      windowsHide: true,
      env: { ...process.env, SENTRIX_HELLO_CMD: cmd, SENTRIX_HELLO_NAME: name, SENTRIX_HELLO_CHALLENGE: challenge }
    })
    let out = ''
    const timer = setTimeout(() => ps.kill(), 120_000)
    ps.stdout.on('data', (d) => (out += d.toString()))
    ps.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, status: 'Error', message: e.message })
    })
    ps.on('close', () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(out.trim()) as HelloResult)
      } catch {
        resolve({ ok: false, status: 'Error', message: 'Windows Hello did not respond' })
      }
    })
    // Trailing blank line: PowerShell only runs a multi-line block read from stdin once it sees one.
    ps.stdin.end(script.replace(/\r\n/g, '\n') + '\n\n')
  })
}

const STATUS_TEXT: Record<string, string> = {
  UserCanceled: 'Windows Hello was cancelled.',
  UserPrefersPassword: 'Windows Hello was cancelled.',
  NotFound: 'The Windows Hello key for Sentrix is missing. Turn Hello off and on again in Settings.',
  NotSupported: 'Windows Hello is not set up on this PC.',
  SecurityDeviceLocked: 'Windows Hello is locked after too many attempts. Use your master password.',
  CredentialAlreadyExists: 'A Windows Hello key already exists. Try again.'
}

function helloError(r: HelloResult): string {
  return STATUS_TEXT[r.status ?? ''] ?? r.message ?? `Windows Hello failed (${r.status ?? 'unknown'}).`
}

let supportedCache: boolean | null = null

export async function helloSupported(): Promise<boolean> {
  if (supportedCache === null) {
    const r = await runHello('supported')
    supportedCache = r.ok && r.supported === true
  }
  return supportedCache
}

type EnrollResult = { ok: true; name: string; challenge: Buffer; signature: Buffer } | { ok: false; error: string }

/** Creates a Hello key and signs a fresh challenge. Shows the Windows Hello prompt (twice). */
export async function helloEnroll(): Promise<EnrollResult> {
  const name = `Sentrix-${randomUUID()}`
  const challenge = newChallenge()
  const r = await runHello('enroll', name, challenge.toString('base64'))
  if (!r.ok || !r.signature) return { ok: false, error: helloError(r) }
  // Sign a second time: the scheme only works if Hello signatures are repeatable.
  const again = await runHello('sign', name, challenge.toString('base64'))
  if (!again.ok || again.signature !== r.signature) {
    await runHello('remove', name)
    return {
      ok: false,
      error: again.ok ? "This PC's Windows Hello does not give repeatable signatures, so Sentrix can't use it." : helloError(again)
    }
  }
  return { ok: true, name, challenge, signature: Buffer.from(r.signature, 'base64') }
}

type SignResult = { ok: true; signature: Buffer } | { ok: false; error: string; canceled: boolean }

/** Shows the Windows Hello prompt and returns the signature over the stored challenge. */
export async function helloSign(blob: HelloBlob): Promise<SignResult> {
  const r = await runHello('sign', blob.name, blob.challenge)
  if (!r.ok || !r.signature) {
    return { ok: false, error: helloError(r), canceled: r.status === 'UserCanceled' || r.status === 'UserPrefersPassword' }
  }
  return { ok: true, signature: Buffer.from(r.signature, 'base64') }
}

export async function helloRemoveKey(name: string): Promise<void> {
  await runHello('remove', name).catch(() => undefined)
}

// ---------------- blob file (additionally protected with Windows DPAPI) ----------------

export const helloPath = (dir: string): string => join(dir, HELLO_FILE)

export function readHelloBlob(dir: string): HelloBlob | null {
  const p = helloPath(dir)
  if (!existsSync(p)) return null
  try {
    return parseBlob(safeStorage.decryptString(readFileSync(p)))
  } catch {
    return null
  }
}

export function writeHelloBlob(dir: string, blob: HelloBlob): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows data protection is not available')
  atomicWrite(helloPath(dir), safeStorage.encryptString(JSON.stringify(blob)))
}

export function deleteHelloBlob(dir: string): void {
  for (const p of [helloPath(dir), `${helloPath(dir)}.bak`]) if (existsSync(p)) unlinkSync(p)
}
