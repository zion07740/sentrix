import { join } from 'node:path'
import { app, BrowserWindow, Menu, powerMonitor, session as electronSession, shell, type IpcMainInvokeEvent } from 'electron'
import { VaultStore } from './vault/store'
import { Session } from './session'
import { registerIpc } from './ipc'
import { BridgeServer } from './bridge/server'

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
const devUrl = process.env.ELECTRON_RENDERER_URL ?? ''

// Development only: keep test vaults away from the real one.
if (!app.isPackaged && process.env.SENTRIX_DATA_DIR) app.setPath('userData', process.env.SENTRIX_DATA_DIR)

// ---------------- process-level hardening ----------------
// A packaged build refuses to start with debugging switches (they would let another
// program inspect the unlocked vault). The matching Node switches are disabled by fuses.
if (app.isPackaged) {
  const debugSwitches = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-allow-origins', 'inspect', 'inspect-brk', 'js-flags']
  const argv = process.argv.join(' ')
  if (debugSwitches.some((s) => app.commandLine.hasSwitch(s) || argv.includes(`--${s}`))) {
    app.exit(1)
  }
}
app.enableSandbox()
app.commandLine.appendSwitch('disable-features', 'Autofill,AutofillServerCommunication,SpareRendererForSitePerProcess')
app.setAppUserModelId('com.sentrix.app')

// One running copy only (it owns the vault and the browser pipe).
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let mainWindow: BrowserWindow | null = null
const store = new VaultStore(app.getPath('userData'))
const session = new Session(store)
const bridge = new BridgeServer(session, () => showWindow())

function showWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** Only our own UI may call the IPC API. */
function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  if (!mainWindow || e.sender !== mainWindow.webContents) return false
  return isDev ? url.startsWith(devUrl) : url.startsWith('file://')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#0e1116',
    title: 'Sentrix',
    autoHideMenuBar: true,
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: isDev,
      webviewTag: false,
      navigateOnDragDrop: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('minimize', () => {
    if (session.unlocked && session.settings.lockOnMinimize) session.lock()
  })
  mainWindow.on('closed', () => (mainWindow = null))

  if (isDev) mainWindow.loadURL(devUrl)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

// Every web contents (incl. any we didn't expect): no navigation, no popups, no webviews.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev, url) => {
    if (!(isDev && url.startsWith(devUrl))) ev.preventDefault()
  })
  contents.on('will-redirect', (ev) => ev.preventDefault())
  contents.on('will-attach-webview', (ev) => ev.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
})

app.whenReady().then(() => {
  if (!isDev) Menu.setApplicationMenu(null)

  const ses = electronSession.defaultSession
  // No network: the UI may only load its own files (or the Vite dev server in development).
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url
    const allowed = u.startsWith('file://') || u.startsWith('devtools://') || u.startsWith('data:') || (isDev && (u.startsWith(devUrl) || u.startsWith(devUrl.replace(/^http/, 'ws'))))
    if (!allowed) console.warn('[sentrix] blocked request:', u)
    cb({ cancel: !allowed })
  })
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (e) => e.preventDefault())

  registerIpc({ session, bridge, window: () => mainWindow, isTrustedSender })

  session.on('locked', () => mainWindow?.webContents.send('evt:locked'))
  session.on('vault-changed', () => mainWindow?.webContents.send('evt:vault-changed'))
  session.on('unlocked', () => {
    if (!session.settings.browserIntegration) bridge.stop()
  })
  bridge.on('pair-request', (req) => mainWindow?.webContents.send('evt:pair-request', req))

  // Lock when Windows locks, sleeps or the user logs off.
  powerMonitor.on('lock-screen', () => session.lock())
  powerMonitor.on('suspend', () => session.lock())
  powerMonitor.on('shutdown', () => session.lock())

  createWindow()

  bridge.start()
})

app.on('second-instance', () => showWindow())

app.on('before-quit', () => {
  session.lock()
  bridge.stop()
})

app.on('window-all-closed', () => app.quit())
