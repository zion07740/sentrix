/**
 * Sentrix encrypted file format (used for both the vault and export files).
 *
 *  offset size  field
 *  0      4     magic "SNTX"
 *  4      1     format version (1)
 *  5      1     kind (1 = vault, 2 = export)
 *  6      4     Argon2id memory KiB (uint32 BE)
 *  10     4     Argon2id iterations (uint32 BE)
 *  14     1     Argon2id parallelism
 *  15     16    salt
 *  31     12    wrap nonce
 *  43     48    wrapped vault key (AES-256-GCM: 32 key bytes + 16 tag)
 *  91     12    data nonce
 *  103    ...   encrypted JSON payload + 16-byte tag
 *
 *  KEK        = Argon2id(password, salt, params)
 *  vault key  = AES-GCM-open(KEK, wrapNonce, wrappedKey, AAD = bytes[0..31))
 *  payload    = AES-GCM-open(vaultKey, dataNonce, body, AAD = bytes[0..103))
 *
 * Every header byte is authenticated, so changing any of them makes decryption fail.
 */
import {
  CryptoError,
  DEFAULT_KDF,
  KEY_LEN,
  type KdfParams,
  NONCE_LEN,
  SALT_LEN,
  TAG_LEN,
  deriveKey,
  open,
  randomKey,
  randomNonce,
  randomSalt,
  seal,
  validateKdf,
  wipe
} from './crypto'

export const MAGIC = Buffer.from('SNTX', 'ascii')
export const FORMAT_VERSION = 1
export enum FileKind {
  Vault = 1,
  Export = 2
}

const OFF_SALT = 15
const OFF_WRAP_NONCE = OFF_SALT + SALT_LEN // 31
const OFF_WRAPPED = OFF_WRAP_NONCE + NONCE_LEN // 43
const WRAPPED_LEN = KEY_LEN + TAG_LEN // 48
const OFF_DATA_NONCE = OFF_WRAPPED + WRAPPED_LEN // 91
export const HEADER_LEN = OFF_DATA_NONCE + NONCE_LEN // 103

/** Everything needed to re-encrypt the file without asking for the password again. */
export interface KeyMaterial {
  kind: FileKind
  kdf: KdfParams
  salt: Buffer
  wrapNonce: Buffer
  wrappedKey: Buffer
  vaultKey: Buffer
}

function prefix(kind: FileKind, kdf: KdfParams, salt: Buffer): Buffer {
  const b = Buffer.alloc(OFF_SALT + SALT_LEN)
  MAGIC.copy(b, 0)
  b.writeUInt8(FORMAT_VERSION, 4)
  b.writeUInt8(kind, 5)
  b.writeUInt32BE(kdf.memoryKiB, 6)
  b.writeUInt32BE(kdf.iterations, 10)
  b.writeUInt8(kdf.parallelism, 14)
  salt.copy(b, OFF_SALT)
  return b
}

/** Create fresh key material (new random vault key) protected by `password`. */
export async function createKeyMaterial(
  kind: FileKind,
  password: string,
  kdf: KdfParams = DEFAULT_KDF
): Promise<KeyMaterial> {
  const vaultKey = randomKey()
  return wrapKey(kind, password, vaultKey, kdf)
}

/** Protect an existing vault key with a (new) password — used for "change master password". */
export async function wrapKey(
  kind: FileKind,
  password: string,
  vaultKey: Buffer,
  kdf: KdfParams = DEFAULT_KDF
): Promise<KeyMaterial> {
  const salt = randomSalt()
  const kek = await deriveKey(password, salt, kdf)
  try {
    const wrapNonce = randomNonce()
    const wrappedKey = seal(kek, wrapNonce, vaultKey, prefix(kind, kdf, salt))
    return { kind, kdf, salt, wrapNonce, wrappedKey, vaultKey: Buffer.from(vaultKey) }
  } finally {
    wipe(kek)
  }
}

/** Serialize + encrypt a payload into a complete file (fresh data nonce every time). */
export function writeEncrypted(km: KeyMaterial, plaintext: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_LEN)
  prefix(km.kind, km.kdf, km.salt).copy(header, 0)
  km.wrapNonce.copy(header, OFF_WRAP_NONCE)
  km.wrappedKey.copy(header, OFF_WRAPPED)
  const dataNonce = randomNonce()
  dataNonce.copy(header, OFF_DATA_NONCE)
  const body = seal(km.vaultKey, dataNonce, plaintext, header)
  return Buffer.concat([header, body])
}

export interface ParsedHeader {
  kind: FileKind
  kdf: KdfParams
  salt: Buffer
  wrapNonce: Buffer
  wrappedKey: Buffer
  dataNonce: Buffer
}

export function parseHeader(file: Buffer): ParsedHeader {
  if (file.length < HEADER_LEN + TAG_LEN) throw new CryptoError('File is too small to be a Sentrix file')
  if (!file.subarray(0, 4).equals(MAGIC)) throw new CryptoError('Not a Sentrix file')
  const version = file.readUInt8(4)
  if (version !== FORMAT_VERSION) throw new CryptoError(`Unsupported file version ${version}`)
  const kind = file.readUInt8(5)
  if (kind !== FileKind.Vault && kind !== FileKind.Export) throw new CryptoError('Unknown file kind')
  const kdf: KdfParams = {
    memoryKiB: file.readUInt32BE(6),
    iterations: file.readUInt32BE(10),
    parallelism: file.readUInt8(14)
  }
  validateKdf(kdf)
  return {
    kind,
    kdf,
    salt: Buffer.from(file.subarray(OFF_SALT, OFF_SALT + SALT_LEN)),
    wrapNonce: Buffer.from(file.subarray(OFF_WRAP_NONCE, OFF_WRAP_NONCE + NONCE_LEN)),
    wrappedKey: Buffer.from(file.subarray(OFF_WRAPPED, OFF_WRAPPED + WRAPPED_LEN)),
    dataNonce: Buffer.from(file.subarray(OFF_DATA_NONCE, OFF_DATA_NONCE + NONCE_LEN))
  }
}

export class WrongPasswordError extends CryptoError {
  constructor() {
    super('Wrong password')
  }
}

/** Decrypt a file with its password. Returns the plaintext and the key material for later saves. */
export async function openWithPassword(
  file: Buffer,
  expectedKind: FileKind,
  password: string
): Promise<{ km: KeyMaterial; plaintext: Buffer }> {
  const h = parseHeader(file)
  if (h.kind !== expectedKind) {
    throw new CryptoError(expectedKind === FileKind.Vault ? 'This is an export file, not a vault' : 'This is a vault file, not an export file')
  }
  const kek = await deriveKey(password, h.salt, h.kdf)
  let vaultKey: Buffer
  try {
    vaultKey = open(kek, h.wrapNonce, h.wrappedKey, file.subarray(0, OFF_SALT + SALT_LEN))
  } catch {
    throw new WrongPasswordError()
  } finally {
    wipe(kek)
  }
  const km: KeyMaterial = { kind: h.kind, kdf: h.kdf, salt: h.salt, wrapNonce: h.wrapNonce, wrappedKey: h.wrappedKey, vaultKey }
  const plaintext = openWithKey(file, km)
  return { km, plaintext }
}

/** Decrypt the payload of a file using already-unwrapped key material. */
export function openWithKey(file: Buffer, km: KeyMaterial): Buffer {
  const h = parseHeader(file)
  try {
    return open(km.vaultKey, h.dataNonce, file.subarray(HEADER_LEN), file.subarray(0, HEADER_LEN))
  } catch {
    throw new CryptoError('The file is damaged or has been tampered with')
  }
}
