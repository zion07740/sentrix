# Security

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's **"Report a vulnerability"** button (Security tab → Advisories) so it can be fixed before details are public.

## Threat model

**Sentrix protects against:**

- Someone getting a copy of your vault file or an export file (stolen laptop, backup leak, intercepted USB stick or message). Without the password, the file is AES-256-GCM ciphertext behind an Argon2id key derivation.
- Tampering with the vault or export file. Every byte, header included, is authenticated, so a modified file is rejected rather than silently loaded.
- Websites trying to trick the extension, for example through lookalike domains, hidden login forms, HTTPS→HTTP downgrades, or pages pretending to be the app or the extension.
- Other programs on the network. Nothing listens on anything except `127.0.0.1`, and the app never makes outbound connections.

**Sentrix cannot protect against:**

- Malware already running as your Windows user while the vault is unlocked. It could read the screen, log keystrokes or read process memory. No password manager can fully defend against this.
- A weak or reused master password. Argon2id slows guessing down, but it can't save a password like `password123`.
- Someone who knows your master password.

## Cryptography

### Vault and export files

```
offset size  field
0      4     magic "SNTX"
4      1     format version (1)
5      1     kind (1 = vault, 2 = export)
6      4     Argon2id memory (KiB, big-endian)
10     4     Argon2id iterations
14     1     Argon2id parallelism
15     16    salt (random)
31     12    wrap nonce (random)
43     48    wrapped vault key (AES-256-GCM, 32-byte key + 16-byte tag)
91     12    data nonce (random, new on every save)
103    ...   AES-256-GCM(JSON payload) + 16-byte tag
```

- `KEK = Argon2id(password (NFKC), salt, 64 MiB, t=3, p=4) → 32 bytes`
- `vaultKey = AES-256-GCM-Open(KEK, wrapNonce, wrappedKey, AAD = bytes[0..31))`
- `payload  = AES-256-GCM-Open(vaultKey, dataNonce, body, AAD = bytes[0..103))`
- The KDF parameters are bounded when a file is read (19 MiB–1 GiB, t = 2–20, p = 1–16). This prevents a malicious file from causing a denial of service or a downgrade.
- Changing the master password re-wraps the same vault key under a new salt and KEK.
- Each export gets its own random vault key and its own export password.
- Files are written atomically (temp file, then fsync, then rename), and the previous version is kept as `.bak`.

### Browser extension ↔ app

- **Transport:** a WebSocket on `127.0.0.1:47719`. Connections are accepted only when `Origin` is `chrome-extension://nbhjpkdbcaanmalbhfdefibmdpcgghcc` (the extension's fixed ID) and `Host` is `127.0.0.1:47719`. Browsers don't let web pages forge the Origin header, and the Host check stops DNS rebinding.
- **Pairing:** ECDH P-256. Both sides derive `key = HKDF-SHA256(secret, salt = extPub‖appPub, "sentrix-pair-v1:key")` and a 6-digit confirmation code from `"sentrix-pair-v1:sas"`. The extension displays the code and you type it into the app. Three wrong codes cancel the pairing. A man-in-the-middle would end up with a different code.
- **Messages:** AES-256-GCM with the pairing key. The AAD binds the client ID and the direction (`req`/`res`), which prevents reflection. Each request carries a timestamp (±2 min) and a random ID that is remembered, which prevents replay. Each response echoes the request ID.
- **What the extension can ask for:** the logins that match the current tab's URL (the URL comes from the browser, not from the page), one credential by ID *for that URL*, a "save/update this login" request for that URL, and a generated password. It can't list or read the rest of the vault.
- Pairing keys live inside the encrypted vault. When the vault is locked, the app answers every request with `locked`. Paired browsers can be revoked in Settings.

## Application hardening

- The renderer runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` and a strict CSP (`default-src 'self'; connect-src 'none'; …`). It never sees the vault key. All crypto and file I/O happen in the main process.
- Every IPC call is checked to come from the app's own window.
- All web requests except the app's own files are cancelled. Navigation, new windows, webviews, downloads and permission requests are all blocked.
- Electron fuses are set: `RunAsNode` off, `NODE_OPTIONS` off, `--inspect` off, embedded ASAR integrity on, only-load-from-ASAR on. Release builds also refuse to start with `--remote-debugging-*` or `--inspect`.
- On lock (manual, idle timeout, Windows lock/sleep/shutdown), the key buffers are overwritten and the decrypted data is dropped.
- JavaScript strings, such as passwords shown in the UI, can't be reliably wiped from memory. This is a known limitation of Electron and of JS-based password managers in general.
