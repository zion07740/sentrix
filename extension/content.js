// Sentrix content script: shows a fill button in login fields and offers to save new logins.
// Security rules:
//  - Nothing is filled until the user clicks (no autofill on page load).
//  - Only visible fields are filled (defeats hidden-form credential harvesting).
//  - Runs in the top frame only; the page URL used for matching comes from the browser, not the page.
//  - All UI lives in a closed shadow root; page data is only ever inserted as text.
;(() => {
  if (window.top !== window || window.__sentrixLoaded) return
  window.__sentrixLoaded = true

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? { ok: false, status: 'extension-error' } : res))
      } catch {
        resolve({ ok: false, status: 'extension-error' })
      }
    })

  // ---------------- field detection ----------------

  const TEXTY = new Set(['text', 'email', 'tel', 'url', ''])
  const USER_HINT = /user|login|email|e-mail|account|identifier|phone|mobile/i
  const SKIP_HINT = /search|captcha|otp|one.?time|code|coupon|promo/i

  function isVisible(el) {
    if (!el || !el.isConnected || el.disabled || el.readOnly) return false
    const r = el.getBoundingClientRect()
    if (r.width < 20 || r.height < 10) return false
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (r.bottom < 0 || r.right < 0 || r.top > vh * 3 || r.left > vw) return false
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || parseFloat(s.opacity) < 0.15) return false
    }
    return true
  }

  const isPassword = (el) => el instanceof HTMLInputElement && el.type === 'password'
  const isUserish = (el) => {
    if (!(el instanceof HTMLInputElement) || !TEXTY.has(el.type)) return false
    const hint = `${el.name} ${el.id} ${el.autocomplete} ${el.placeholder} ${el.getAttribute('aria-label') || ''}`
    if (SKIP_HINT.test(hint) && !USER_HINT.test(hint)) return false
    return true
  }

  function scopeOf(el) {
    return el.form || el.closest('form') || document
  }

  /** The login "unit" an input belongs to: its username and password fields. */
  function loginFields(anchor) {
    const scope = scopeOf(anchor)
    const inputs = [...scope.querySelectorAll('input')].filter(isVisible)
    const passwords = inputs.filter(isPassword)
    let username = null
    const ref = isPassword(anchor) ? anchor : passwords[0]
    if (isUserish(anchor)) username = anchor
    else if (ref) {
      const before = inputs.slice(0, inputs.indexOf(ref)).filter(isUserish)
      username = before.reverse().find((i) => USER_HINT.test(`${i.name} ${i.id} ${i.autocomplete} ${i.type}`)) || before[0] || null
    }
    return { username, passwords }
  }

  /** Should we offer Sentrix on this input? Password fields always; username fields only if a login form is around. */
  function isCandidate(el) {
    if (!(el instanceof HTMLInputElement) || !isVisible(el)) return false
    if (isPassword(el)) return true
    if (!isUserish(el)) return false
    const ac = (el.autocomplete || '').toLowerCase()
    if (ac === 'username' || ac === 'email') return true
    const scope = scopeOf(el)
    const hasPw = [...scope.querySelectorAll('input[type=password]')].some(isVisible)
    return hasPw || (USER_HINT.test(`${el.name} ${el.id} ${el.placeholder}`) && scope !== document)
  }

  function setValue(el, value) {
    el.focus({ preventScroll: true })
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // ---------------- UI (closed shadow root) ----------------

  const host = document.createElement('sentrix-ui')
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;'
  const root = host.attachShadow({ mode: 'closed' })
  const css = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: 'Segoe UI', system-ui, sans-serif; }
      .btn { position: fixed; width: 24px; height: 24px; border-radius: 6px; border: none; padding: 3px; cursor: pointer;
             background: transparent; display: none; }
      .btn:hover { background: rgba(47,211,163,.18); }
      .btn svg { display: block; }
      .menu { position: fixed; width: 300px; max-height: 320px; overflow: auto; display: none; background: #151a23; color: #e8ecf3;
              border: 1px solid #2f3849; border-radius: 12px; box-shadow: 0 16px 40px rgba(0,0,0,.45); padding: 6px; font-size: 13px; }
      .head { display: flex; align-items: center; gap: 8px; padding: 6px 8px 8px; font-weight: 600; color: #a7b0c0; font-size: 12px; }
      
      .item { display: flex; flex-direction: column; width: 100%; text-align: left; border: none; background: transparent; color: inherit;
              padding: 8px 10px; border-radius: 8px; cursor: pointer; }
      .item:hover, .item:focus { background: #222a38; outline: none; }
      .item b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .item span { color: #7b869a; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .msg { padding: 10px; color: #a7b0c0; line-height: 1.45; }
      .sep { height: 1px; background: #242b3a; margin: 6px 4px; }
      .banner { position: fixed; top: 16px; right: 16px; width: 340px; display: none; background: #151a23; color: #e8ecf3;
                border: 1px solid #2f3849; border-radius: 14px; box-shadow: 0 16px 40px rgba(0,0,0,.45); padding: 14px 16px; font-size: 13.5px; }
      .banner .title { display: flex; align-items: center; gap: 10px; font-weight: 600; margin-bottom: 4px; }
      
      .banner .sub { color: #a7b0c0; font-size: 12.5px; margin-bottom: 12px; word-break: break-all; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; }
      .act { border: 1px solid #2f3849; background: #1b2130; color: #e8ecf3; border-radius: 8px; padding: 7px 14px; font-weight: 600; cursor: pointer; font-size: 13px; }
      .act.primary { background: linear-gradient(135deg,#2fd3a3,#3fb0d0); color: #04140f; border-color: transparent; }`
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  root.adoptedStyleSheets = [sheet]
  // Built with createElement (not innerHTML) so pages enforcing Trusted Types don't break us.
  const btn = document.createElement('button')
  btn.className = 'btn'
  btn.title = 'Fill with Sentrix'
  btn.setAttribute('aria-label', 'Fill with Sentrix')
  const menu = document.createElement('div')
  menu.className = 'menu'
  menu.setAttribute('role', 'menu')
  const banner = document.createElement('div')
  banner.className = 'banner'
  banner.setAttribute('role', 'dialog')
  banner.setAttribute('aria-label', 'Save to Sentrix')
  root.append(btn, menu, banner)

  // Inline SVG logo (an <img> to an extension URL would need web_accessible_resources and can be blocked by page CSP).
  const SVG_NS = 'http://www.w3.org/2000/svg'
  let logoCount = 0
  function logo(size) {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 64 64')
    svg.setAttribute('width', String(size))
    svg.setAttribute('height', String(size))
    // Unique id per copy: a gradient inside a hidden element stops rendering for every other user of that id.
    const gradId = `sx-grad-${++logoCount}`
    const grad = document.createElementNS(SVG_NS, 'linearGradient')
    grad.id = gradId
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0'); grad.setAttribute('x2', '1'); grad.setAttribute('y2', '1')
    for (const [o, c] of [['0', '#2fd3a3'], ['1', '#4f8cff']]) {
      const st = document.createElementNS(SVG_NS, 'stop')
      st.setAttribute('offset', o)
      st.setAttribute('stop-color', c)
      grad.append(st)
    }
    const defs = document.createElementNS(SVG_NS, 'defs')
    defs.append(grad)
    const shield = document.createElementNS(SVG_NS, 'path')
    shield.setAttribute('d', 'M32 4 8 13v17c0 15 10.3 25.6 24 30 13.7-4.4 24-15 24-30V13z')
    shield.setAttribute('fill', `url(#${gradId})`)
    const hole = document.createElementNS(SVG_NS, 'path')
    hole.setAttribute('d', 'M32 21a7 7 0 0 0-3.5 13.06L26.5 46h11l-2-11.94A7 7 0 0 0 32 21z')
    hole.setAttribute('fill', '#0b0e13')
    svg.append(defs, shield, hole)
    return svg
  }
  btn.append(logo(18))
  ;(document.documentElement || document.body).appendChild(host)

  let current = null // the input the button is attached to

  function place() {
    if (!current || !isVisible(current)) return hideButton()
    const r = current.getBoundingClientRect()
    btn.style.left = `${r.right - 28}px`
    btn.style.top = `${r.top + (r.height - 24) / 2}px`
    btn.style.display = 'block'
    if (menu.style.display === 'block') {
      // Open on whichever side has more room, and never taller than that room.
      const spaceBelow = window.innerHeight - r.bottom - 12
      const spaceAbove = r.top - 12
      const below = spaceBelow >= 220 || spaceBelow >= spaceAbove
      menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 310))}px`
      menu.style.maxHeight = `${Math.max(120, Math.min(320, below ? spaceBelow : spaceAbove))}px`
      menu.style.top = below ? `${r.bottom + 6}px` : 'auto'
      menu.style.bottom = below ? 'auto' : `${window.innerHeight - r.top + 6}px`
    }
  }
  function hideButton() {
    btn.style.display = 'none'
    closeMenu()
  }
  function closeMenu() {
    menu.style.display = 'none'
    menu.replaceChildren()
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function menuHeader() {
    const h = el('div', 'head')
    h.append(logo(16), el('span', null, 'Sentrix'))
    return h
  }

  const STATUS_TEXT = {
    locked: 'Sentrix is locked. Unlock it in the Sentrix app, then try again.',
    unpaired: 'This browser is not connected yet. Click the Sentrix icon in the toolbar and choose "Connect".',
    'app-not-running': 'The Sentrix app is not running (or Browser autofill is off in its Settings).',
    timeout: 'Sentrix did not answer. Is the app open?',
    'bad-sender': 'Sentrix only works on normal web pages.',
    replay: 'Please try again.',
    'extension-error': 'The extension was updated. Reload this page.'
  }

  async function openMenu() {
    if (!current) return
    const target = current
    menu.replaceChildren(menuHeader(), el('div', 'msg', 'Loading…'))
    menu.style.display = 'block'
    place()
    const res = await send({ type: 'matches' })
    if (current !== target) return
    menu.replaceChildren(menuHeader())
    if (!res?.ok) {
      menu.append(el('div', 'msg', STATUS_TEXT[res?.status] || 'Could not reach Sentrix.'))
    } else if (!res.items.length) {
      menu.append(el('div', 'msg', 'No saved logins for this site.'))
    } else {
      for (const item of res.items) {
        const b = el('button', 'item')
        b.append(el('b', null, item.title || 'Login'), el('span', null, item.username || '(no username)'))
        b.addEventListener('click', (e) => e.isTrusted && fill(target, item.id))
        menu.append(b)
      }
    }
    if (res?.ok && isPassword(target)) {
      menu.append(el('div', 'sep'))
      const g = el('button', 'item')
      g.append(el('b', null, 'Generate strong password'), el('span', null, 'Fills new-password fields on this form'))
      g.addEventListener('click', async (e) => {
        if (!e.isTrusted) return
        const r = await send({ type: 'generate' })
        if (r?.ok) {
          const { passwords } = loginFields(target)
          for (const p of passwords) setValue(p, r.password)
          closeMenu()
        }
      })
      menu.append(g)
    }
    place()
  }

  async function fill(target, id) {
    const res = await send({ type: 'fill', id })
    closeMenu()
    if (!res?.ok) return
    const { username, passwords } = loginFields(target)
    if (username && res.username && isVisible(username)) setValue(username, res.username)
    const pw = isPassword(target) ? target : passwords[0]
    if (pw && res.password && isVisible(pw)) setValue(pw, res.password)
  }

  btn.addEventListener('mousedown', (e) => e.preventDefault()) // keep focus in the field
  btn.addEventListener('click', (e) => {
    if (!e.isTrusted) return
    menu.style.display === 'block' ? closeMenu() : openMenu()
  })

  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.composedPath()[0]
      if (t instanceof HTMLInputElement && isCandidate(t)) {
        if (current !== t) closeMenu()
        current = t
        place()
      }
    },
    true
  )
  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.composedPath().includes(host)) return
      const t = e.composedPath()[0]
      if (t !== current) {
        closeMenu()
        if (!(t instanceof HTMLInputElement && isCandidate(t))) hideButton()
      }
    },
    true
  )
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu(), true)
  window.addEventListener('scroll', place, true)
  window.addEventListener('resize', place)

  // ---------------- save new / changed logins ----------------

  let lastSubmit = 0
  function capture(fromEl) {
    const now = Date.now()
    if (now - lastSubmit < 1500) return
    const scope = fromEl ? scopeOf(fromEl) : document
    const pwField = [...scope.querySelectorAll('input[type=password]')].find((p) => isVisible(p) && p.value)
    if (!pwField) return
    lastSubmit = now
    const { username, passwords } = loginFields(pwField)
    // On "change password" forms the last filled field is usually the new password.
    const filled = passwords.filter((p) => p.value)
    const password = filled.length >= 2 ? filled[filled.length - 1].value : pwField.value
    send({ type: 'submitted', username: username?.value || '', password }).then((r) => {
      if (r?.ok && r.action !== 'none') showBanner({ action: r.action, host: r.host, username: username?.value || '' })
    })
  }
  document.addEventListener('submit', (e) => capture(e.target), true)
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return
      const b = e.target instanceof Element ? e.target.closest('button, input[type=submit], [role=button]') : null
      if (b && (b.type === 'submit' || /log\s?in|sign\s?in|sign\s?up|register|continue|next|save|submit/i.test(b.textContent || b.value || ''))) capture(b)
    },
    true
  )
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.isTrusted && e.key === 'Enter' && isPassword(e.target)) capture(e.target)
    },
    true
  )

  function showBanner(offer) {
    banner.replaceChildren()
    const title = el('div', 'title')
    title.append(logo(22), el('span', null, offer.action === 'update' ? 'Update password in Sentrix?' : 'Save login to Sentrix?'))
    const sub = el('div', 'sub', `${offer.username ? offer.username + ' · ' : ''}${offer.host}`)
    const actions = el('div', 'actions')
    const no = el('button', 'act', 'Not now')
    const yes = el('button', 'act primary', offer.action === 'update' ? 'Update' : 'Save')
    no.addEventListener('click', (e) => {
      if (!e.isTrusted) return
      send({ type: 'dismiss-offer' })
      banner.style.display = 'none'
    })
    yes.addEventListener('click', async (e) => {
      if (!e.isTrusted) return
      const r = await send({ type: 'save-offer' })
      banner.replaceChildren(el('div', 'title', r?.ok ? 'Saved to Sentrix ✓' : STATUS_TEXT[r?.status] || 'Could not save.'))
      setTimeout(() => (banner.style.display = 'none'), 1800)
    })
    actions.append(no, yes)
    banner.append(title, sub, actions)
    banner.style.display = 'block'
  }

  // A login usually navigates away; pick up an offer made on the previous page.
  send({ type: 'pending-offer' }).then((r) => r?.ok && r.offer && showBanner(r.offer))
})()
