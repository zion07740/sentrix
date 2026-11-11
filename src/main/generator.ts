import { randomInt } from 'node:crypto'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import type { GeneratorOptions, PassphraseOptions } from '@shared/types'

const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?/~'
const AMBIGUOUS = /[Il1O0o|`'"]/g

/** crypto.randomInt is uniform (no modulo bias). */
const pick = (s: string): string => s[randomInt(s.length)]

export function generatePassword(opts: GeneratorOptions): string {
  const length = Math.min(128, Math.max(8, Math.floor(opts.length) || 20))
  const clean = (s: string) => (opts.excludeAmbiguous ? s.replace(AMBIGUOUS, '') : s)
  const sets = [
    opts.lowercase && clean(LOWER),
    opts.uppercase && clean(UPPER),
    opts.digits && clean(DIGITS),
    opts.symbols && clean(SYMBOLS)
  ].filter((s): s is string => !!s)
  if (sets.length === 0) sets.push(clean(LOWER))
  const all = sets.join('')
  // one character from each chosen set, the rest from the full pool, then shuffle
  const chars = sets.map(pick)
  while (chars.length < length) chars.push(pick(all))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

export function generatePassphrase(opts: PassphraseOptions): string {
  const count = Math.min(12, Math.max(3, Math.floor(opts.words) || 5))
  const sep = typeof opts.separator === 'string' ? opts.separator.slice(0, 3) : '-'
  const words = Array.from({ length: count }, () => {
    const w = wordlist[randomInt(wordlist.length)]
    return opts.capitalize ? w[0].toUpperCase() + w.slice(1) : w
  })
  if (opts.includeNumber) {
    const i = randomInt(words.length)
    words[i] = words[i] + randomInt(10)
  }
  return words.join(sep)
}
