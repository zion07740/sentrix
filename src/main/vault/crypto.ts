import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { argon2id } from 'hash-wasm'

export interface KdfParams {
  /** memory in KiB */
  memoryKiB: number
  iterations: number
  parallelism: number
}

/** Argon2id defaults: 64 MiB, 3 passes, 4 lanes (OWASP-recommended range). */
export const DEFAULT_KDF: KdfParams = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 4 }

/** Bounds accepted when reading a file — rejects absurd values in a hostile file (DoS / downgrade). */
export const KDF_LIMITS = {
  memoryKiB: { min: 19 * 1024, max: 1024 * 1024 },
  iterations: { min: 2, max: 20 },
  parallelism: { min: 1, max: 16 }
}

export const KEY_LEN = 32
export const NONCE_LEN = 12
export const TAG_LEN = 16
export const SALT_LEN = 16

export function validateKdf(p: KdfParams): void {
  const ok =
    Number.isInteger(p.memoryKiB) &&
    Number.isInteger(p.iterations) &&
    Number.isInteger(p.parallelism) &&
    p.memoryKiB >= KDF_LIMITS.memoryKiB.min &&
    p.memoryKiB <= KDF_LIMITS.memoryKiB.max &&
    p.iterations >= KDF_LIMITS.iterations.min &&
    p.iterations <= KDF_LIMITS.iterations.max &&
    p.parallelism >= KDF_LIMITS.parallelism.min &&
    p.parallelism <= KDF_LIMITS.parallelism.max
  if (!ok) throw new CryptoError('Unsupported key-derivation parameters')
}

export class CryptoError extends Error {}

/** Derive a 32-byte key from a password with Argon2id. */
export async function deriveKey(password: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  validateKdf(params)
  if (salt.length !== SALT_LEN) throw new CryptoError('Bad salt')
  const out = await argon2id({
    password: password.normalize('NFKC'),
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: KEY_LEN,
    outputType: 'binary'
  })
  const key = Buffer.from(out)
  out.fill(0)
  return key
}

/** AES-256-GCM encrypt. Returns ciphertext || 16-byte tag. */
export function seal(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  if (key.length !== KEY_LEN || nonce.length !== NONCE_LEN) throw new CryptoError('Bad key or nonce')
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN })
  c.setAAD(aad)
  const body = Buffer.concat([c.update(plaintext), c.final()])
  return Buffer.concat([body, c.getAuthTag()])
}

/** AES-256-GCM decrypt; throws CryptoError if the key is wrong or anything was tampered with. */
export function open(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (key.length !== KEY_LEN || nonce.length !== NONCE_LEN) throw new CryptoError('Bad key or nonce')
  if (sealed.length < TAG_LEN) throw new CryptoError('Ciphertext too short')
  const body = sealed.subarray(0, sealed.length - TAG_LEN)
  const tag = sealed.subarray(sealed.length - TAG_LEN)
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN })
    d.setAAD(aad)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(body), d.final()])
  } catch {
    throw new CryptoError('Decryption failed')
  }
}

export const randomKey = (): Buffer => randomBytes(KEY_LEN)
export const randomNonce = (): Buffer => randomBytes(NONCE_LEN)
export const randomSalt = (): Buffer => randomBytes(SALT_LEN)

export function wipe(...bufs: Array<Buffer | null | undefined>): void {
  for (const b of bufs) if (b) b.fill(0)
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
