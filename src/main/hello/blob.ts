/**
 * Windows Hello key wrapping (pure, no Electron/Windows dependencies, so it is unit-testable).
 *
 *   signature = WindowsHello.Sign(challenge)          (RSA PKCS#1 v1.5, deterministic, TPM key, needs PIN/face/finger)
 *   helloKey  = HKDF-SHA256(signature, salt = challenge, info = "sentrix-hello-v1", 32)
 *   wrapped   = AES-256-GCM(helloKey, nonce, vaultKey, AAD = "sentrix-hello-v1|<name>|<challenge>")
 *
 * The challenge, key name and nonce are not secret. Without a Hello gesture nobody can
 * produce the signature, so nobody can rebuild helloKey.
 */
import { hkdfSync, randomBytes } from 'node:crypto'
import { KEY_LEN, open, seal, wipe } from '../vault/crypto'

export interface HelloBlob {
  v: 1
  name: string
  challenge: string
  nonce: string
  wrapped: string
}

const INFO = 'sentrix-hello-v1'
const aad = (name: string, challenge: string) => Buffer.from(`${INFO}|${name}|${challenge}`)

export function newChallenge(): Buffer {
  return randomBytes(32)
}

export function deriveHelloKey(signature: Buffer, challenge: Buffer): Buffer {
  if (signature.length < 64) throw new Error('Signature too short')
  return Buffer.from(hkdfSync('sha256', signature, challenge, INFO, KEY_LEN))
}

export function wrapForHello(vaultKey: Buffer, signature: Buffer, challenge: Buffer, name: string): HelloBlob {
  const key = deriveHelloKey(signature, challenge)
  try {
    const nonce = randomBytes(12)
    const c = challenge.toString('base64')
    const wrapped = seal(key, nonce, vaultKey, aad(name, c))
    return { v: 1, name, challenge: c, nonce: nonce.toString('base64'), wrapped: wrapped.toString('base64') }
  } finally {
    wipe(key)
  }
}

/** Throws if the signature is wrong or the blob was modified. */
export function unwrapWithHello(blob: HelloBlob, signature: Buffer): Buffer {
  const challenge = Buffer.from(blob.challenge, 'base64')
  const key = deriveHelloKey(signature, challenge)
  try {
    return open(key, Buffer.from(blob.nonce, 'base64'), Buffer.from(blob.wrapped, 'base64'), aad(blob.name, blob.challenge))
  } finally {
    wipe(key)
  }
}

export function parseBlob(json: string): HelloBlob {
  const b = JSON.parse(json) as HelloBlob
  if (b?.v !== 1 || typeof b.name !== 'string' || !/^Sentrix-[0-9a-f-]{36}$/.test(b.name) || typeof b.challenge !== 'string' || typeof b.nonce !== 'string' || typeof b.wrapped !== 'string') {
    throw new Error('Invalid Windows Hello data')
  }
  return b
}
