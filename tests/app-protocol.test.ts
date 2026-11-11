import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ protocol: {} }))
const { resolveRendererFile } = await import('../src/main/app-protocol')

const ROOT = join('C:\\', 'Program Files', 'Sentrix', 'resources', 'app.asar', 'out', 'renderer')

describe('app:// file resolution', () => {
  it('serves files inside the renderer folder', () => {
    expect(resolveRendererFile(ROOT, 'app://sentrix/index.html')?.file).toBe(join(ROOT, 'index.html'))
    expect(resolveRendererFile(ROOT, 'app://sentrix/')?.file).toBe(join(ROOT, 'index.html'))
    expect(resolveRendererFile(ROOT, 'app://sentrix/assets/index-abc.js')?.type).toMatch(/javascript/)
  })

  it('blocks every way out of the folder', () => {
    for (const u of [
      'app://sentrix/../../package.json',
      'app://sentrix/%2e%2e/%2e%2e/package.json',
      'app://sentrix/..%2f..%2fpackage.json',
      'app://sentrix/..%5c..%5cpackage.json',
      'app://sentrix/assets/..%5c..%5c..%5cvault.sentrix.html',
      'app://sentrix/%2e%2e%5c%2e%2e%5cwin.ini',
      'app://sentrix/index.html%00.js'
    ]) {
      const r = resolveRendererFile(ROOT, u)
      if (r) expect(r.file.startsWith(ROOT)).toBe(true)
    }
    expect(resolveRendererFile(ROOT, 'app://sentrix/..%5c..%5cpackage.json')).toBeNull()
  })

  it('rejects other hosts, schemes and unknown file types', () => {
    expect(resolveRendererFile(ROOT, 'app://evil/index.html')).toBeNull()
    expect(resolveRendererFile(ROOT, 'file:///C:/Windows/win.ini')).toBeNull()
    expect(resolveRendererFile(ROOT, 'app://sentrix/secret.sentrix')).toBeNull()
    expect(resolveRendererFile(ROOT, 'app://sentrix/%E0%A4%A')).toBeNull()
  })
})
