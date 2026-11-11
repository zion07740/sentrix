import { createECDH, webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { urlMatches } from '../src/main/bridge/match'
import { derivePairing, deriveFromSecret, openMessage, ReplayGuard, sealMessage } from '../src/main/bridge/protocol'

describe('urlMatches', () => {
  const cases: Array<[string, string, boolean]> = [
    ['https://github.com', 'https://github.com/login', true],
    ['github.com', 'https://github.com/login', true],
    ['https://accounts.google.com', 'https://mail.google.com/', true],
    ['https://example.co.uk', 'https://login.example.co.uk/', true],
    // lookalikes and different sites
    ['https://github.com', 'https://github.com.evil.io/login', false],
    ['https://github.com', 'https://evil-github.com/', false],
    ['https://example.co.uk', 'https://other.co.uk/', false],
    // private suffixes: each user's site is separate
    ['https://alice.github.io', 'https://bob.github.io/', false],
    ['https://alice.github.io', 'https://alice.github.io/app', true],
    // no https → http downgrade
    ['https://bank.com', 'http://bank.com/', false],
    ['http://router.local', 'http://router.local/', true],
    // IPs and localhost need exact host (and port if saved)
    ['http://192.168.1.1', 'http://192.168.1.1/admin', true],
    ['http://192.168.1.1', 'http://192.168.1.2/', false],
    ['http://localhost:3000', 'http://localhost:3000/login', true],
    ['http://localhost:3000', 'http://localhost:4000/login', false],
    // non-web pages never match
    ['https://github.com', 'file:///C:/github.com.html', false],
    ['https://github.com', 'chrome://settings', false],
    ['', 'https://github.com', false]
  ]
  for (const [entry, page, expected] of cases) {
    it(`${entry || '(empty)'} on ${page} → ${expected}`, () => expect(urlMatches(entry, page)).toBe(expected))
  }
})

describe('pairing protocol', () => {
  it('extension (WebCrypto) and app (Node) derive the same key and code', async () => {
    const subtle = webcrypto.subtle
    const ext = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const extPub = Buffer.from(await subtle.exportKey('raw', ext.publicKey))
    const app = derivePairing(extPub.toString('base64'))

    const appKey = await subtle.importKey('raw', Buffer.from(app.appPub, 'base64'), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    const secret = Buffer.from(await subtle.deriveBits({ name: 'ECDH', public: appKey }, ext.privateKey, 256))
    const mine = deriveFromSecret(secret, extPub, Buffer.from(app.appPub, 'base64'))
    expect(mine.key.equals(app.key)).toBe(true)
    expect(mine.code).toBe(app.code)
    expect(app.code).toMatch(/^\d{6}$/)
  })

  it('a man-in-the-middle gets a different code', () => {
    const ext = createECDH('prime256v1')
    const extPub = ext.generateKeys()
    const attacker = createECDH('prime256v1')
    attacker.generateKeys()
    const real = derivePairing(extPub.toString('base64'))
    // attacker substitutes its own key towards the extension
    const secretSeenByExt = ext.computeSecret(attacker.getPublicKey())
    const fake = deriveFromSecret(secretSeenByExt, extPub, attacker.getPublicKey())
    expect(fake.code).not.toBe(real.code)
    expect(fake.key.equals(real.key)).toBe(false)
  })

  it('rejects malformed public keys', () => {
    expect(() => derivePairing(Buffer.alloc(65).toString('base64'))).toThrow()
    expect(() => derivePairing('AAAA')).toThrow()
  })

  it('messages are bound to client and direction', () => {
    const key = Buffer.alloc(32, 7)
    const m = sealMessage(key, 'client-a', 'req', { hello: 1 })
    expect(openMessage(key, 'client-a', 'req', m)).toEqual({ hello: 1 })
    expect(() => openMessage(key, 'client-b', 'req', m)).toThrow()
    expect(() => openMessage(key, 'client-a', 'res', m)).toThrow() // reflection
    expect(() => openMessage(Buffer.alloc(32, 8), 'client-a', 'req', m)).toThrow()
    const tampered = { ...m, ct: Buffer.from(Buffer.from(m.ct, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64') }
    expect(() => openMessage(key, 'client-a', 'req', tampered)).toThrow()
  })

  it('replay guard rejects repeats and stale timestamps', () => {
    const g = new ReplayGuard(120_000)
    const rid = 'abcdefghijklmnopqrstuvwx'
    expect(g.accept(1_000_000, rid, 1_000_000)).toBe(true)
    expect(g.accept(1_000_000, rid, 1_000_500)).toBe(false)
    expect(g.accept(1_000_000, 'zyxwvutsrqponmlkjihgfedc', 1_000_000 + 200_000)).toBe(false)
    expect(g.accept('x', 'zyxwvutsrqponmlkjihgfedc')).toBe(false)
    expect(g.accept(Date.now(), 'short')).toBe(false)
  })
})
