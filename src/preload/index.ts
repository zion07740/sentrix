import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PairRequest, SentrixApi } from '../shared/types'

const call =
  <A extends unknown[], R>(channel: string) =>
  (...args: A): Promise<R> =>
    ipcRenderer.invoke(channel, ...args)

const api: SentrixApi = {
  app: {
    state: call('app:state'),
    openExternal: call('app:openExternal'),
    activity: call('app:activity')
  },
  vault: {
    create: call('vault:create'),
    unlock: call('vault:unlock'),
    lock: call('vault:lock'),
    changePassword: call('vault:changePassword'),
    list: call('vault:list'),
    get: call('vault:get'),
    save: call('vault:save'),
    trash: call('vault:trash'),
    restore: call('vault:restore'),
    deleteForever: call('vault:deleteForever'),
    emptyTrash: call('vault:emptyTrash'),
    totp: call('vault:totp')
  },
  clipboard: {
    copyField: call('clipboard:copyField'),
    copyText: call('clipboard:copyText')
  },
  generator: {
    password: call('gen:password'),
    passphrase: call('gen:passphrase')
  },
  transfer: {
    exportEncrypted: call('transfer:exportEncrypted'),
    pickImportFile: call('transfer:pickImportFile'),
    importEncrypted: call('transfer:importEncrypted'),
    importCsv: call('transfer:importCsv'),
    exportCsv: call('transfer:exportCsv')
  },
  settings: {
    get: call('settings:get'),
    set: call('settings:set')
  },
  browser: {
    list: call('browser:list'),
    revoke: call('browser:revoke'),
    approve: call('browser:approve'),
    deny: call('browser:deny'),
    extensionId: call('browser:extensionId'),
    status: call('browser:status'),
    openExtensionFolder: call('browser:openExtensionFolder')
  },
  on(event, cb) {
    const channel = `evt:${event}`
    const listener = () => cb()
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  onPairRequest(cb) {
    const listener = (_e: IpcRendererEvent, req: PairRequest) => cb(req)
    ipcRenderer.on('evt:pair-request', listener)
    return () => ipcRenderer.removeListener('evt:pair-request', listener)
  }
}

contextBridge.exposeInMainWorld('sentrix', api)
