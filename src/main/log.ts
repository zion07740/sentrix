import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Tiny error log for troubleshooting: %APPDATA%\Sentrix\logs\sentrix.log (rotated at 1 MB).
 * Only error messages and stack traces are written: never vault data, passwords or keys.
 */
let file: string | null = null

export function initLog(dataDir: string): void {
  const dir = join(dataDir, 'logs')
  mkdirSync(dir, { recursive: true })
  file = join(dir, 'sentrix.log')
}

export function logError(context: string, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err))
  const line = `${new Date().toISOString()} [${context}] ${e.name}: ${e.message}\n${(e.stack ?? '').split('\n').slice(1, 8).join('\n')}\n`
  console.error(line)
  if (!file) return
  try {
    if (existsSync(file) && statSync(file).size > 1024 * 1024) renameSync(file, `${file}.1`)
    appendFileSync(file, line)
  } catch {
    /* logging must never crash the app */
  }
}
