import { Secret, TOTP, URI } from 'otpauth'
import type { TotpCode } from '@shared/types'

/** Accepts either an otpauth:// URI or a bare base32 secret. */
export function parseTotp(value: string): TOTP | null {
  const v = value.trim()
  if (!v) return null
  try {
    if (/^otpauth:\/\//i.test(v)) {
      const parsed = URI.parse(v)
      return parsed instanceof TOTP ? parsed : null
    }
    return new TOTP({ secret: Secret.fromBase32(v.replace(/[\s-]/g, '').toUpperCase()), digits: 6, period: 30, algorithm: 'SHA1' })
  } catch {
    return null
  }
}

export function totpNow(value: string, now = Date.now()): TotpCode | null {
  const t = parseTotp(value)
  if (!t) return null
  const code = t.generate({ timestamp: now })
  const remaining = t.period - (Math.floor(now / 1000) % t.period)
  return { code, remaining, period: t.period }
}
