// Zips the browser extension for the GitHub release (Windows: uses PowerShell's Compress-Archive).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'))
const out = join(root, 'release', `Sentrix-extension-${version}.zip`)
mkdirSync(dirname(out), { recursive: true })
rmSync(out, { force: true })
execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${join(root, 'extension')}\*' -DestinationPath '${out}'`], { stdio: 'inherit' })
console.log(`[extension] ${out}`)
