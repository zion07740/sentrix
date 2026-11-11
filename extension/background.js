// Sentrix extension service worker: the only part that talks to the desktop app.
import { derivePairing, newKeyPair, open, randomId, seal } from './crypto.js'

// The Sentrix app listens on this loopback port (127.0.0.1 only). Must match BRIDGE_PORT in the app.
const APP_URL = 'ws://127.0.0.1:47719'
const REQUEST_TIMEOUT_MS = 10_000
const PAIR_POLL_MS = 1500
const PAIR_TIMEOUT_MS = 5 * 60_000
const SAVE_OFFER_TTL_MS = 2 * 60_000

// tabId → pending "save this login?" offer (kept in memory + session storage, never on disk)
const saveOffers = new Map()

// ---------------- transport ----------------

/** One request → one response over a short-lived local WebSocket. */
function native(msg) {
  return new Promise((resolve) => {
    let done = false
    const finish = (res) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      resolve(res)
    }
    let ws
    try {
      ws = new WebSocket(APP_URL)
    } catch {
      return resolve({ type: 'error', code: 'app-not-running' })
    }
    const timer = setTimeout(() => finish({ type: 'error', code: 'timeout' }), REQUEST_TIMEOUT_MS)
    ws.onopen = () => ws.send(JSON.stringify(msg))
    ws.onmessage = (e) => {
      try {
        finish(JSON.parse(e.data))
      } catch {
        finish({ type: 'error', code: 'bad-response' })
      }
    }
    ws.onerror = () => finish({ type: 'error', code: 'app-not-running' })
    ws.onclose = () => finish({ type: 'error', code: 'app-not-running' })
  })
}

async function getPairing() {
  const { pairing } = await chrome.storage.local.get('pairing')
  return pairing ?? null
}

/** Send an encrypted request; returns { ok, ...result } or { ok:false, status }. */
async function request(action, payload = {}) {
  const pairing = await getPairing()
  if (!pairing) return { ok: false, status: 'unpaired' }
  const rid = randomId()
  const body = await seal(pairing.key, pairing.clientId, 'req', { ts: Date.now(), rid, action, payload })
  const res = await native({ type: 'msg', clientId: pairing.clientId, ...body })
  if (res?.type === 'error') {
    if (res.code === 'unpaired') await chrome.storage.local.remove('pairing')
    return { ok: false, status: res.code }
  }
  if (res?.type !== 'msg') return { ok: false, status: 'bad-response' }
  let out
  try {
    out = await open(pairing.key, pairing.clientId, 'res', res)
  } catch {
    return { ok: false, status: 'bad-response' }
  }
  if (out.rid !== rid) return { ok: false, status: 'bad-response' }
  return out.result
}

async function status() {
  const pairing = await getPairing()
  const hello = await native({ type: 'hello' })
  if (hello.type === 'error') return { status: hello.code, paired: !!pairing }
  if (!pairing) return { status: 'unpaired', paired: false }
  if (!hello.unlocked) return { status: 'locked', paired: true }
  const ping = await request('ping')
  return { status: ping.ok ? 'ready' : ping.status, paired: !!(await getPairing()) }
}

// ---------------- pairing ----------------

function browserName() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? []
  const name = brands.find((b) => /Edge|Brave|Opera|Vivaldi/i.test(b)) ?? brands.find((b) => /Chrome/i.test(b)) ?? 'Browser'
  return `${name.replace('Microsoft ', '').replace('Google ', '')} (${navigator.userAgentData?.platform || 'Windows'})`
}

async function startPairing() {
  const { privateKey, pub } = await newKeyPair()
  const res = await native({ type: 'pair-begin', pub: btoa(String.fromCharCode(...pub)), name: browserName() })
  if (res.type === 'error') return { ok: false, status: res.code }
  if (res.type !== 'pair-pending') return { ok: false, status: 'bad-response' }
  const { key, code } = await derivePairing(privateKey, pub, res.appPub)
  const pending = { clientId: res.clientId, key, code, startedAt: Date.now() }
  await chrome.storage.session.set({ pendingPair: pending })
  pollPairing(pending)
  return { ok: true, code }
}

async function pollPairing(pending) {
  while (Date.now() - pending.startedAt < PAIR_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, PAIR_POLL_MS))
    const { pendingPair } = await chrome.storage.session.get('pendingPair')
    if (!pendingPair || pendingPair.clientId !== pending.clientId) return
    const res = await native({ type: 'pair-status', clientId: pending.clientId })
    const state = res.type === 'pair-status' ? res.state : 'pending'
    if (state === 'approved') {
      await chrome.storage.local.set({ pairing: { clientId: pending.clientId, key: pending.key, pairedAt: Date.now() } })
      await chrome.storage.session.set({ pendingPair: { ...pending, key: null, state: 'approved' } })
      return
    }
    if (state === 'denied' || state === 'unknown') {
      await chrome.storage.session.set({ pendingPair: { ...pending, key: null, state: 'denied' } })
      return
    }
  }
  await chrome.storage.session.remove('pendingPair')
}

// ---------------- save offers ----------------

async function rememberOffer(tabId, offer) {
  saveOffers.set(tabId, offer)
  await chrome.storage.session.set({ [`offer:${tabId}`]: offer })
}
async function takeOffer(tabId, consume) {
  let offer = saveOffers.get(tabId)
  if (!offer) offer = (await chrome.storage.session.get(`offer:${tabId}`))[`offer:${tabId}`]
  if (!offer || Date.now() - offer.at > SAVE_OFFER_TTL_MS) return null
  if (consume) {
    saveOffers.delete(tabId)
    await chrome.storage.session.remove(`offer:${tabId}`)
  }
  return offer
}
chrome.tabs.onRemoved.addListener((tabId) => {
  saveOffers.delete(tabId)
  chrome.storage.session.remove(`offer:${tabId}`)
})

const sameSite = (a, b) => {
  try {
    const x = new URL(a)
    const y = new URL(b)
    const base = (h) => h.split('.').slice(-2).join('.')
    return x.protocol === y.protocol && base(x.hostname) === base(y.hostname)
  } catch {
    return false
  }
}

// ---------------- message routing ----------------

async function fromContent(msg, sender) {
  // Only the top-level frame of a real tab, and we use the URL Chrome reports — never one the page claims.
  if (!sender.tab || sender.frameId !== 0 || !sender.url) return { ok: false, status: 'bad-sender' }
  const url = sender.url
  if (!/^https?:/i.test(url)) return { ok: false, status: 'bad-sender' }
  const tabId = sender.tab.id

  switch (msg.type) {
    case 'matches': {
      const r = await request('matches', { url })
      if (!r.ok && r.status === 'locked') native({ type: 'show-app' })
      return r
    }
    case 'fill':
      return request('credential', { url, id: String(msg.id) })
    case 'generate':
      return request('generate')
    case 'submitted': {
      const username = String(msg.username ?? '').slice(0, 1000)
      const password = String(msg.password ?? '').slice(0, 10_000)
      if (!password) return { ok: true, action: 'none' }
      const r = await request('check-save', { url, username, password })
      if (r.ok && r.action !== 'none') {
        await rememberOffer(tabId, { url, username, password, action: r.action, id: r.id ?? null, host: r.host, at: Date.now() })
      }
      return r
    }
    case 'pending-offer': {
      const offer = await takeOffer(tabId, false)
      if (!offer || !sameSite(offer.url, url)) return { ok: true, offer: null }
      return { ok: true, offer: { action: offer.action, host: offer.host, username: offer.username } }
    }
    case 'save-offer': {
      const offer = await takeOffer(tabId, true)
      if (!offer) return { ok: false, status: 'expired' }
      return request('save', { url: offer.url, username: offer.username, password: offer.password, id: offer.id ?? undefined })
    }
    case 'dismiss-offer':
      await takeOffer(tabId, true)
      return { ok: true }
    default:
      return { ok: false, status: 'unknown' }
  }
}

async function fromPopup(msg) {
  switch (msg.type) {
    case 'status':
      return status()
    case 'pair':
      return startPairing()
    case 'pair-state': {
      const { pendingPair } = await chrome.storage.session.get('pendingPair')
      return pendingPair ? { code: pendingPair.code, state: pendingPair.state ?? 'pending' } : null
    }
    case 'pair-clear':
      await chrome.storage.session.remove('pendingPair')
      return { ok: true }
    case 'unpair':
      await chrome.storage.local.remove('pairing')
      return { ok: true }
    case 'show-app':
      return native({ type: 'show-app' })
    case 'tab-matches': {
      const url = String(msg.url ?? '')
      if (!/^https?:/i.test(url)) return { ok: true, items: [] }
      return request('matches', { url })
    }
    case 'tab-credential':
      return request('credential', { url: String(msg.url ?? ''), id: String(msg.id) })
    case 'generate':
      return request('generate')
    default:
      return { ok: false, status: 'unknown' }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false
  const isPopup = !sender.tab && !!sender.url?.startsWith(chrome.runtime.getURL(''))
  const handler = isPopup ? fromPopup(msg) : fromContent(msg, sender)
  handler.then(sendResponse, (e) => sendResponse({ ok: false, status: 'error', message: String(e?.message ?? e) }))
  return true
})
