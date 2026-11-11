/**
 * Browser-extension ↔ app protocol crypto.
 *
 * Pairing (once per browser profile):
 *   ext → app  { pub: P-256 public key (raw, base64) }
 *   app → ext  { pub: P-256 public key }
 *   both:  secret = ECDH(...)
 *          key    = HKDF-SHA256(secret, salt = extPub || appPub, "sentrix-pair-v1:key", 32)
 *          code   = HKDF-SHA256(secret, salt = extPub || appPub, "sentrix-pair-v1:sas", 4) mod 10^6
 *   The extension shows the 6-digit code; the user types it into the app.
 *   A man-in-the-middle would end up with a different code, so pairing fails.
 *
 * After pairing every message is AES-256-GCM with that key. The AAD binds the
 * client id and the direction, and each request carries a timestamp and a random id
 * so a recorded message can't be replayed.
 */
import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'

const b64 = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64')
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64')

export interface PairingResult {
  appPub: string
  key: Buffer
  code: string
}

export function derivePairing(extPubB64: string): PairingResult {
  const extPub = unb64(extPubB64)
  if (extPub.length !== 65 || extPub[0] !== 0x04) throw new Error('Bad public key')
  const ecdh = createECDH('prime256v1')
  const appPub = ecdh.generateKeys()
  const secret = ecdh.computeSecret(extPub)
  const { key, code } = deriveFromSecret(secret, extPub, appPub)
  secret.fill(0)
  return { appPub: b64(appPub), key, code }
}

export function deriveFromSecret(secret: Buffer, extPub: Buffer, appPub: Buffer): { key: Buffer; code: string } {
  const salt = Buffer.concat([extPub, appPub])
  const key = Buffer.from(hkdfSync('sha256', secret, salt, 'sentrix-pair-v1:key', 32))
  const sas = Buffer.from(hkdfSync('sha256', secret, salt, 'sentrix-pair-v1:sas', 4))
  const code = String(sas.readUInt32BE(0) % 1_000_000).padStart(6, '0')
  return { key, code }
}

export type Direction = 'req' | 'res'

export interface Sealed {
  iv: string
  ct: string
}

const aad = (clientId: string, dir: Direction) => Buffer.from(`sentrix-v1|${clientId}|${dir}`)

export function sealMessage(key: Buffer, clientId: string, dir: Direction, payload: unknown): Sealed {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(aad(clientId, dir))
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final(), c.getAuthTag()])
  return { iv: b64(iv), ct: b64(ct) }
}

export function openMessage(key: Buffer, clientId: string, dir: Direction, msg: Sealed): unknown {
  const iv = unb64(msg.iv)
  const ct = unb64(msg.ct)
  if (iv.length !== 12 || ct.length < 16) throw new Error('Malformed message')
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAAD(aad(clientId, dir))
  d.setAuthTag(ct.subarray(ct.length - 16))
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  return JSON.parse(pt.toString('utf8'))
}

/** Rejects requests that are too old/new or whose random id was already seen. */
export class ReplayGuard {
  private seen = new Map<string, number>()
  constructor(private windowMs = 120_000) {}

  accept(ts: unknown, rid: unknown, now = Date.now()): boolean {
    if (typeof ts !== 'number' || typeof rid !== 'string' || rid.length < 16 || rid.length > 64) return false
    if (Math.abs(now - ts) > this.windowMs) return false
    for (const [id, exp] of this.seen) if (exp < now) this.seen.delete(id)
    if (this.seen.has(rid)) return false
    this.seen.set(rid, now + this.windowMs * 2)
    return true
  }
}
