import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { protocol } from 'electron'

/**
 * The UI is served from app://sentrix/ instead of file://. That lets us switch off Electron's
 * extra file:// privileges (fuse grantFileProtocolExtraPrivileges=false) while still loading the
 * UI's script modules, and it can only ever serve files from the bundled renderer folder.
 */
export const APP_SCHEME = 'app'
export const APP_ORIGIN = 'app://sentrix'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

/** Must run before app "ready". */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

/** Maps an app:// URL to a file inside rendererDir, or null if it isn't one we serve. */
export function resolveRendererFile(rendererDir: string, rawUrl: string): { file: string; type: string } | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== 'sentrix') return null
  let rel: string
  try {
    rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
  } catch {
    return null
  }
  if (rel.includes('\0')) return null
  const root = normalize(rendererDir)
  const file = normalize(join(root, rel))
  if (!file.startsWith(root + sep)) return null // no escaping the folder with ".." (either slash)
  const type = MIME[extname(file).toLowerCase()]
  return type ? { file, type } : null
}

export function serveRenderer(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const hit = resolveRendererFile(rendererDir, request.url)
      if (!hit) return new Response('Not found', { status: 404 })
      const { file, type } = hit
      return new Response(await readFile(file), {
        headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
