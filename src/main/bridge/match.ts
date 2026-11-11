import { getDomain, parse } from 'tldts'

interface ParsedUrl {
  protocol: string
  hostname: string
  port: string
}

function parseUrl(raw: string, assumeHttps: boolean): ParsedUrl | null {
  const s = raw.trim()
  if (!s) return null
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
    if (!hasScheme && !assumeHttps) return null
    const u = new URL(hasScheme ? s : `https://${s}`)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (!u.hostname) return null
    return { protocol: u.protocol, hostname: u.hostname.toLowerCase().replace(/\.$/, ''), port: u.port }
  } catch {
    return null
  }
}

/**
 * Should a saved login (with `entryUrl`) be offered on the page at `pageUrl`?
 *
 *  - Only http(s) pages.
 *  - Normal sites: same registrable domain (eTLD+1, using the Public Suffix List),
 *    so `accounts.example.com` matches `example.com`, but `example.com.evil.io`
 *    and `foo.github.io` vs `bar.github.io` do not.
 *  - IP addresses, localhost and other hosts without a public suffix: exact host + port.
 *  - An https login is never offered on an http page (no downgrade).
 */
export function urlMatches(entryUrl: string, pageUrl: string): boolean {
  const page = parseUrl(pageUrl, false)
  const entry = parseUrl(entryUrl, true)
  if (!page || !entry) return false
  if (entry.protocol === 'https:' && page.protocol !== 'https:') return false

  // allowPrivateDomains: treat github.io, blogspot.com, … as suffixes, so each user site is its own domain
  const opts = { allowPrivateDomains: true }
  const pageInfo = parse(page.hostname, opts)
  const entryInfo = parse(entry.hostname, opts)
  if (pageInfo.isIp || entryInfo.isIp || !pageInfo.domain || !entryInfo.domain) {
    return page.hostname === entry.hostname && (entry.port === '' || entry.port === page.port)
  }
  return getDomain(page.hostname, opts) === getDomain(entry.hostname, opts)
}

export function originOf(pageUrl: string): string | null {
  const p = parseUrl(pageUrl, false)
  return p ? `${p.protocol}//${p.hostname}${p.port ? `:${p.port}` : ''}` : null
}

export function hostOf(pageUrl: string): string {
  return parseUrl(pageUrl, true)?.hostname.replace(/^www\./, '') ?? ''
}
