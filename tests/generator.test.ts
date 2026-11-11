import { describe, expect, it } from 'vitest'
import { generatePassphrase, generatePassword } from '../src/main/generator'
import { entriesFromCsv, entriesToCsv, parseCsv } from '../src/main/vault/csv'
import { totpNow } from '../src/main/totp'

describe('generator', () => {
  it('respects length and character sets', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword({ length: 24, lowercase: true, uppercase: true, digits: true, symbols: false, excludeAmbiguous: true })
      expect(p).toHaveLength(24)
      expect(p).toMatch(/[a-z]/)
      expect(p).toMatch(/[A-Z]/)
      expect(p).toMatch(/[0-9]/)
      expect(p).not.toMatch(/[^a-zA-Z0-9]/)
      expect(p).not.toMatch(/[Il1O0o]/)
    }
  })

  it('clamps length', () => {
    expect(generatePassword({ length: 2, lowercase: true, uppercase: false, digits: false, symbols: false, excludeAmbiguous: false })).toHaveLength(8)
  })

  it('makes passphrases', () => {
    const p = generatePassphrase({ words: 5, separator: '-', capitalize: true, includeNumber: true })
    expect(p.split('-')).toHaveLength(5)
    expect(p).toMatch(/\d/)
  })
})

describe('csv', () => {
  it('parses quoted fields', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere']
    ])
  })

  it('imports a Proton Pass style CSV and round-trips', () => {
    const csv =
      'type,name,url,email,username,password,note,totp,createTime,modifyTime,vault\n' +
      'login,GitHub,https://github.com,me@x.com,,"p,w""1",,JBSWY3DPEHPK3PXP,1,1,Personal\n'
    const entries = entriesFromCsv(csv)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ title: 'GitHub', username: 'me@x.com', password: 'p,w"1', urls: ['https://github.com'] })
    const back = entriesFromCsv(entriesToCsv(entries))
    expect(back[0].password).toBe('p,w"1')
  })
})

describe('totp', () => {
  it('matches the RFC 6238 test vector', () => {
    // secret "12345678901234567890" (base32 below), T = 59 s → 94287082; 6 digits → 287082
    expect(totpNow('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)?.code).toBe('287082')
  })

  it('rejects junk', () => {
    expect(totpNow('not a secret!!')).toBeNull()
  })
})
