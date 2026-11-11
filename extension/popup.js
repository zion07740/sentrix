const main = document.getElementById('main')
const dot = document.getElementById('dot')
const unpairBtn = document.getElementById('unpair')
const send = (msg) => chrome.runtime.sendMessage(msg)

const h = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function setDot(kind, title) {
  dot.className = `dot ${kind}`
  dot.title = title
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

function note(text) {
  main.append(h('p', 'muted small', text))
}

/** Copy through the Sentrix app: it clears the clipboard later and keeps it out of Windows clipboard history. */
async function copyFromApp(url, id, field, label) {
  const r = await send({ type: 'tab-copy', url, id, field })
  if (!r?.ok) return note(`Could not copy (${r?.status ?? r?.error ?? 'error'}).`)
  note(r.clearSeconds ? `${label} copied. Sentrix clears it in ${r.clearSeconds} seconds.` : `${label} copied.`)
}

async function render() {
  const pending = await send({ type: 'pair-state' })
  if (pending && pending.state === 'pending') return renderPairing(pending.code)
  if (pending && pending.state !== 'pending') await send({ type: 'pair-clear' })

  const st = await send({ type: 'status' })
  unpairBtn.hidden = !st.paired
  main.replaceChildren()

  switch (st.status) {
    case 'app-not-running':
    case 'timeout':
      setDot('err', 'App not running')
      main.append(
        h('h2', null, 'Sentrix is not running'),
        h('p', 'muted', 'Open the Sentrix desktop app on this computer, then click this icon again. If it is open, check that "Browser autofill" is on in its Settings.')
      )
      return
    case 'unpaired': {
      setDot('warn', 'Not connected')
      main.append(h('h2', null, 'Connect this browser'), h('p', 'muted', 'Link this browser to the Sentrix app so it can fill your passwords. Sentrix must be unlocked.'))
      const b = h('button', 'btn', 'Connect to Sentrix')
      b.onclick = async () => {
        b.disabled = true
        const r = await send({ type: 'pair' })
        if (r.ok) renderPairing(r.code)
        else {
          b.disabled = false
          main.append(h('p', 'muted', r.status === 'locked' ? 'Unlock Sentrix first, then try again.' : `Could not start (${r.status}).`))
        }
      }
      main.append(b)
      return
    }
    case 'locked': {
      setDot('warn', 'Locked')
      main.append(h('h2', null, 'Sentrix is locked'), h('p', 'muted', 'Unlock the app to fill passwords.'))
      const b = h('button', 'btn', 'Open Sentrix')
      b.onclick = () => send({ type: 'show-app' })
      main.append(b)
      return
    }
    case 'ready':
      setDot('ready', 'Connected')
      return renderMatches()
    default:
      setDot('err', st.status)
      main.append(h('p', 'muted', `Something went wrong (${st.status}). Try again.`))
  }
}

function renderPairing(code) {
  setDot('warn', 'Pairing')
  main.replaceChildren(
    h('h2', null, 'Enter this code in Sentrix'),
    h('div', 'code', code),
    h('p', 'muted small', 'A window opened in the Sentrix app. Type this code there to finish connecting. You can close this popup.')
  )
  const poll = setInterval(async () => {
    const p = await send({ type: 'pair-state' })
    if (!p || p.state !== 'pending') {
      clearInterval(poll)
      if (p?.state === 'denied') main.replaceChildren(h('h2', null, 'Pairing cancelled'), h('p', 'muted', 'The code was denied or expired.'))
      await send({ type: 'pair-clear' })
      setTimeout(render, p?.state === 'denied' ? 1500 : 0)
    }
  }, 1000)
}

async function renderMatches() {
  const tab = await activeTab()
  const url = tab?.url ?? ''
  const isWeb = /^https?:/.test(url)
  let host = ''
  try {
    if (isWeb) host = new URL(url).hostname
  } catch {}
  main.replaceChildren(h('p', 'muted small', host ? `Logins for ${host}` : 'Open a website to see its logins.'))
  if (!isWeb) return
  const r = await send({ type: 'tab-matches', url })
  if (!r.ok) return main.append(h('p', 'muted', `Could not load (${r.status}).`))
  if (!r.items.length) return main.append(h('p', 'muted', 'No saved logins for this site.'))
  for (const item of r.items) {
    const row = h('div', 'item')
    const text = h('div')
    text.append(h('b', null, item.title || 'Login'), h('span', null, item.username || '(no username)'))
    const u = h('button', 'chip', 'User')
    const p = h('button', 'chip', 'Pass')
    u.onclick = () => copyFromApp(url, item.id, 'username', 'Username')
    p.onclick = () => copyFromApp(url, item.id, 'password', 'Password')
    row.append(text, u, p)
    main.append(row)
  }
  main.append(h('p', 'muted small', 'Tip: click the Sentrix icon inside a login field to fill it.'))
}

document.getElementById('gen').onclick = async () => {
  const r = await send({ type: 'generate' })
  if (!r.ok) return
  main.replaceChildren(h('h2', null, 'Generated password'), h('div', 'gen', r.password))
  const b = h('button', 'btn', 'Copy')
  b.onclick = async () => {
    await navigator.clipboard.writeText(r.password)
    note('Copied. Paste it, then save the login so it is not lost.')
  }
  main.append(b)
}

unpairBtn.onclick = async () => {
  if (!confirm('Disconnect this browser from Sentrix?')) return
  await send({ type: 'unpair' })
  render()
}

render()
