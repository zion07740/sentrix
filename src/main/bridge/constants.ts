/** Fixed extension ID, derived from the "key" in extension/manifest.json. */
export const EXTENSION_ID = 'nbhjpkdbcaanmalbhfdefibmdpcgghcc'
export const EXTENSION_ORIGINS = new Set([`chrome-extension://${EXTENSION_ID}`])

/** Loopback port the extension connects to. Must match PORT in extension/background.js. */
export const BRIDGE_PORT = 47719
export const BRIDGE_HOST = '127.0.0.1'
