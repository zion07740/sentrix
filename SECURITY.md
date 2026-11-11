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

### Windows Hello unlock

Windows Hello unlock is optional and off by default. Turning it on requires your master password.

- Sentrix asks Windows Hello to create an RSA key named `Sentrix-<uuid>`. The private key stays inside Windows Hello (the TPM where available), and using it requires your PIN, fingerprint or face.
- Sentrix signs a random 32-byte challenge with that key: `helloKey = HKDF-SHA256(signature, salt = challenge, "sentrix-hello-v1")`. During setup it signs twice and refuses to continue if the two signatures differ.
- The vault key is wrapped with `helloKey` using AES-256-GCM (the AAD binds the key name and challenge). It is stored in `%APPDATA%\Sentrix\hello.sentrix`, which is also encrypted with Windows DPAPI (`safeStorage`), tying it to your Windows account.
- Unlocking asks Windows Hello for the signature again, rebuilds `helloKey`, and unwraps the vault key. Without a Hello gesture the key can't be rebuilt.
- After 5 failed Hello unlocks in a row, the master password is required.
- Turning Hello off deletes both the file and the Windows Hello key. Changing the master password doesn't affect Hello, because the vault key stays the same.
- Sentrix talks to Windows Hello through Windows PowerShell's built-in access to the Windows APIs. The script is passed on standard input, so there is no extra executable or script file on disk.

**Limits:** Hello unlock stops someone at your keyboard who doesn't know your PIN or lacks your fingerprint. Like the rest of Sentrix, it can't defend against malware already running as your Windows user.

### Password health

The report is computed in the main process. Passwords are compared through their SHA-256 hashes, which are kept in memory only. Only entry IDs, titles and issue flags are sent to the UI. Nothing is sent over the network: there are no breach-database lookups.

## Application hardening

- The renderer runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` and a strict CSP (`default-src 'self'; connect-src 'none'; …`). It never sees the vault key. All crypto and file I/O happen in the main process.
- The UI is served from a private `app://sentrix/` scheme instead of `file://`. Requests that try to escape the UI folder are rejected (unit-tested against encoded `../` and `..\` tricks).
- Every IPC call is checked to come from the app's own window at `app://sentrix/`.
- All web requests except the app's own files are cancelled. Navigation, new windows, webviews, downloads and permission requests are all blocked.
- Electron fuses are set: `RunAsNode` off, `NODE_OPTIONS` off, `--inspect` off, embedded ASAR integrity on, only-load-from-ASAR on, extra `file://` privileges off. Release builds also refuse to start with `--remote-debugging-*` or `--inspect`.
- Helper programs are launched by full path (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`), never by bare name. This means a planted `powershell.exe` next to the app can't be picked up.
- Copied secrets carry Windows' `ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory = 0` and `CanUploadToCloudClipboard = 0` formats, so they stay out of clipboard history and cloud sync. The clipboard is cleared after the configured time, but only if it still holds the copied value.
- When "Browser autofill" is off, a non-secret marker file next to the vault makes sure the local listener isn't started, even before unlock.
- The extension only checks "save this login?" for real user submissions (`isTrusted`). A page script can't submit forms itself to probe saved passwords.
- Imported items with timestamps far in the future are clamped to the present, so a bad clock or a crafted file can't block later edits from winning merges.
- On lock (manual, idle timeout, Windows lock/sleep/shutdown, an unexpected error, or a UI crash), the key buffers are overwritten and the decrypted data is dropped.
- If the vault file is damaged, the previous copy is opened with the same password and the damaged file is kept aside. This never happens on a *wrong* password, because that could roll back to an older vault after a password change.
- Errors go to `%APPDATA%\Sentrix\logs\sentrix.log` (error messages and stack traces only, no vault data).

## Supply chain

- Only a handful of runtime dependencies ship: `hash-wasm`, `otpauth`, `@zxcvbn-ts/*`, `tldts`, `ws`, `@scure/bip39`. CI fails the build if `npm audit` finds a high or critical issue in any of them.
- Dependabot opens weekly update PRs for npm packages and GitHub Actions.
- Releases are built on GitHub's runners, ship with `SHA256SUMS.txt`, and carry signed build provenance (`gh attestation verify <file> --repo zion07740/sentrix`).
- The executables are not Authenticode-signed yet, so Windows SmartScreen warns on first run.
- JavaScript strings, such as passwords shown in the UI, can't be reliably wiped from memory. This is a known limitation of Electron and of JS-based password managers in general.
