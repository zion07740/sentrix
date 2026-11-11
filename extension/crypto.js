// WebCrypto side of the Sentrix extension ↔ app protocol (mirrors src/main/bridge/protocol.ts).

const enc = new TextEncoder()
const dec = new TextDecoder()

export const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export async function newKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, pub }
}

async function hkdf(secret, salt, info, bytes) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, base, bytes * 8)
  return new Uint8Array(bits)
}

/** ECDH + HKDF → shared 32-byte key and the 6-digit confirmation code. */
export async function derivePairing(privateKey, extPub, appPubB64) {
  const appPub = unb64(appPubB64)
  const appKey = await crypto.subtle.importKey('raw', appPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: appKey }, privateKey, 256))
  const salt = new Uint8Array(extPub.length + appPub.length)
  salt.set(extPub, 0)
  salt.set(appPub, extPub.length)
  const key = await hkdf(secret, salt, 'sentrix-pair-v1:key', 32)
  const sas = await hkdf(secret, salt, 'sentrix-pair-v1:sas', 4)
  secret.fill(0)
  const n = new DataView(sas.buffer).getUint32(0, false) % 1_000_000
  return { key: b64(key), code: String(n).padStart(6, '0') }
}

const aad = (clientId, dir) => enc.encode(`sentrix-v1|${clientId}|${dir}`)
const importAes = (keyB64) => crypto.subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, ['encrypt', 'decrypt'])

export async function seal(keyB64, clientId, dir, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await importAes(keyB64)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(clientId, dir) }, key, enc.encode(JSON.stringify(payload)))
  return { iv: b64(iv), ct: b64(ct) }
}

export async function open(keyB64, clientId, dir, msg) {
  const key = await importAes(keyB64)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(msg.iv), additionalData: aad(clientId, dir) }, key, unb64(msg.ct))
  return JSON.parse(dec.decode(pt))
}

export const randomId = () => b64(crypto.getRandomValues(new Uint8Array(18)))
