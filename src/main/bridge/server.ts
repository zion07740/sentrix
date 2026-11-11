import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Entry, PairRequest } from '@shared/types'
import type { Session } from '../session'
import { applyInput, sanitizeEntry } from '../vault/entry'
import { generatePassword } from '../generator'
import { totpNow } from '../totp'
import { constantTimeEqual } from '../vault/crypto'
import { derivePairing, openMessage, ReplayGuard, sealMessage, type Sealed } from './protocol'
import { hostOf, originOf, urlMatches } from './match'
import { BRIDGE_HOST, BRIDGE_PORT, EXTENSION_ORIGINS } from './constants'

const MAX_FRAME = 64 * 1024
const PAIR_TTL_MS = 5 * 60_000
const MAX_PENDING = 3

interface PendingPair {
  clientId: string
  name: string
  key: Buffer
  code: string
  attempts: number
  createdAt: number
  state: 'pending' | 'approved' | 'denied'
}

type Json = Record<string, unknown>

/**
 * Local server the Sentrix browser extension talks to.
 *
 * Transport: WebSocket bound to 127.0.0.1 only (unreachable from other machines).
 *  - Only connections whose Origin is the Sentrix extension are accepted. Web pages
 *    can't forge the Origin header, so websites can't talk to this server.
 *  - The Host header must be 127.0.0.1:<port>, which defeats DNS-rebinding tricks.
 *  - After pairing, every message is end-to-end encrypted and authenticated (see protocol.ts).
 */
export class BridgeServer extends EventEmitter {
  private server: WebSocketServer | null = null
  lastError: string | null = null
  private pending = new Map<string, PendingPair>()
  private replay = new ReplayGuard()

  constructor(
    private session: Session,
    private showWindow: () => void
  ) {
    super()
  }

  start(): void {
    if (this.server) return
    this.lastError = null
    const server = new WebSocketServer({
      host: BRIDGE_HOST,
      port: BRIDGE_PORT,
      maxPayload: MAX_FRAME,
      perMessageDeflate: false,
      verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) =>
        EXTENSION_ORIGINS.has(origin) && req.headers.host === `${BRIDGE_HOST}:${BRIDGE_PORT}`
    })
    server.on('connection', (ws) => this.onConnection(ws))
    server.on('error', (err: NodeJS.ErrnoException) => {
      this.lastError = err.code === 'EADDRINUSE' ? `Port ${BRIDGE_PORT} is already in use by another program` : err.message
      console.error('[bridge] server error:', err.message)
      this.server = null
    })
    this.server = server
  }

  stop(): void {
    this.server?.close()
    for (const c of this.server?.clients ?? []) c.terminate()
    this.server = null
  }

  get running(): boolean {
    return this.server !== null
  }

  // ---------------- pairing (called from the UI) ----------------

  approve(clientId: string, code: string): { ok: boolean; error?: string } {
    const p = this.pending.get(clientId)
    if (!p || p.state !== 'pending' || Date.now() - p.createdAt > PAIR_TTL_MS) return { ok: false, error: 'This pairing request has expired. Start again from the browser.' }
    if (!this.session.unlocked) return { ok: false, error: 'Unlock Sentrix first.' }
    if (!constantTimeEqual(code.replace(/\s/g, ''), p.code)) {
      p.attempts++
      if (p.attempts >= 3) {
        p.state = 'denied'
        return { ok: false, error: 'Wrong code too many times. Pairing cancelled.' }
      }
      return { ok: false, error: 'That code does not match. Check the code shown in the browser extension.' }
    }
    const v = this.session.store.vault
    v.pairings = v.pairings.filter((x) => x.clientId !== clientId)
    v.pairings.push({ clientId, name: p.name, key: p.key.toString('base64'), createdAt: Date.now(), lastUsedAt: Date.now() })
    this.session.commit()
    p.state = 'approved'
    return { ok: true }
  }

  deny(clientId: string): void {
    const p = this.pending.get(clientId)
    if (p) p.state = 'denied'
  }

  // ---------------- transport ----------------

  private onConnection(ws: WebSocket): void {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(1003)
      let msg: Json
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return ws.close(1007)
      }
      if (!msg || typeof msg !== 'object') return ws.close(1007)
      this.handle(msg)
        .catch((e) => ({ type: 'error', code: 'internal', message: String(e?.message ?? e) }))
        .then((res) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(res))
        })
    })
    ws.on('error', () => ws.terminate())
  }

  private async handle(msg: Json): Promise<Json> {
    switch (msg.type) {
      case 'hello':
        return { type: 'hello', app: 'Sentrix', unlocked: this.session.unlocked }
      case 'show-app':
        this.showWindow()
        return { type: 'ok' }
      case 'pair-begin':
        return this.pairBegin(msg)
      case 'pair-status':
        return this.pairStatus(msg)
      case 'msg':
        return this.encrypted(msg)
      default:
        return { type: 'error', code: 'unknown-type' }
    }
  }

  private pairBegin(msg: Json): Json {
    if (!this.session.unlocked) return { type: 'error', code: 'locked' }
    if (typeof msg.pub !== 'string') return { type: 'error', code: 'bad-request' }
    const now = Date.now()
    for (const [id, p] of this.pending) if (now - p.createdAt > PAIR_TTL_MS || p.state !== 'pending') this.pending.delete(id)
    if (this.pending.size >= MAX_PENDING) return { type: 'error', code: 'busy' }
    const { appPub, key, code } = derivePairing(msg.pub)
    const clientId = randomUUID()
    const name = typeof msg.name === 'string' ? msg.name.slice(0, 60) : 'Browser'
    this.pending.set(clientId, { clientId, name, key, code, attempts: 0, createdAt: now, state: 'pending' })
    const req: PairRequest = { clientId, name }
    this.emit('pair-request', req)
    this.showWindow()
    return { type: 'pair-pending', clientId, appPub }
  }

  private pairStatus(msg: Json): Json {
    const p = typeof msg.clientId === 'string' ? this.pending.get(msg.clientId) : undefined
    if (!p) return { type: 'pair-status', state: 'unknown' }
    if (p.state !== 'pending') this.pending.delete(p.clientId)
    return { type: 'pair-status', state: p.state }
  }

  private async encrypted(msg: Json): Promise<Json> {
    if (!this.session.unlocked) return { type: 'error', code: 'locked' }
    const clientId = typeof msg.clientId === 'string' ? msg.clientId : ''
    const pairing = this.session.store.vault.pairings.find((p) => p.clientId === clientId)
    if (!pairing) return { type: 'error', code: 'unpaired' }
    const key = Buffer.from(pairing.key, 'base64')
    let req: Json
    try {
      req = openMessage(key, clientId, 'req', msg as unknown as Sealed) as Json
    } catch {
      return { type: 'error', code: 'bad-message' }
    }
    if (!this.replay.accept(req.ts, req.rid)) return { type: 'error', code: 'replay' }
    pairing.lastUsedAt = Date.now()
    this.session.touch()
    const result = await this.action(String(req.action), (req.payload ?? {}) as Json)
    return { type: 'msg', ...sealMessage(key, clientId, 'res', { rid: req.rid, result }) }
  }

  // ---------------- actions (only reached by a paired, unlocked, authenticated client) ----------------

  private loginsFor(url: string): Entry[] {
    return this.session.store.vault.entries.filter((e) => e.type === 'login' && e.trashedAt === null && e.urls.some((u) => urlMatches(u, url)))
  }

  private async action(action: string, p: Json): Promise<Json> {
    const url = typeof p.url === 'string' ? p.url : ''
    switch (action) {
      case 'matches': {
        const list = this.loginsFor(url)
          .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt - a.updatedAt)
          .map((e) => ({ id: e.id, title: e.title, username: e.username }))
        return { ok: true, items: list }
      }
      case 'credential': {
        const e = this.loginsFor(url).find((x) => x.id === p.id)
        if (!e) return { ok: false, error: 'not-found' }
        return { ok: true, username: e.username, password: e.password, totp: e.totp ? totpNow(e.totp)?.code ?? null : null }
      }
      case 'copy': {
        // Copied by the app, so it gets the auto-clear timer and stays out of clipboard history.
        const e = this.loginsFor(url).find((x) => x.id === p.id)
        if (!e) return { ok: false, error: 'not-found' }
        const value = p.field === 'username' ? e.username : p.field === 'password' ? e.password : ''
        if (!value) return { ok: false, error: 'empty' }
        await this.session.copySecret(value)
        return { ok: true, clearSeconds: this.session.settings.clipboardClearSeconds }
      }
      case 'check-save': {
        const username = typeof p.username === 'string' ? p.username : ''
        const password = typeof p.password === 'string' ? p.password : ''
        if (!password || !originOf(url)) return { ok: true, action: 'none' }
        const same = this.loginsFor(url).filter((e) => e.username === username)
        if (same.length === 0) return { ok: true, action: 'save', host: hostOf(url) }
        if (same.some((e) => e.password === password)) return { ok: true, action: 'none' }
        return { ok: true, action: 'update', id: same[0].id, host: hostOf(url) }
      }
      case 'save': {
        const origin = originOf(url)
        const username = typeof p.username === 'string' ? p.username.slice(0, 1000) : ''
        const password = typeof p.password === 'string' ? p.password.slice(0, 10_000) : ''
        if (!origin || !password) return { ok: false, error: 'bad-request' }
        const v = this.session.store.vault
        if (typeof p.id === 'string') {
          const existing = this.loginsFor(url).find((e) => e.id === p.id)
          if (!existing) return { ok: false, error: 'not-found' }
          const updated = applyInput({ ...existing, password }, existing)
          v.entries = v.entries.map((e) => (e.id === existing.id ? updated : e))
        } else {
          const created = applyInput(
            { type: 'login', title: hostOf(url), username, password, urls: [origin], notes: '', totp: '', tags: [], favorite: false },
            undefined
          )
          if (!sanitizeEntry(created)) return { ok: false, error: 'bad-request' }
          v.entries.push(created)
        }
        this.session.commit()
        return { ok: true }
      }
      case 'generate':
        return { ok: true, password: generatePassword({ length: 20, lowercase: true, uppercase: true, digits: true, symbols: true, excludeAmbiguous: true }) }
      case 'ping':
        return { ok: true }
      default:
        return { ok: false, error: 'unknown-action' }
    }
  }
}
