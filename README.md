<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your app

This contains everything you need to run your app locally.

## Run Locally

**Prerequisites:**  Node.js >=20.19.0 (20 LTS baseline), npm >=10.8.2

> `package-lock.json` is maintained with Node 20.19.x + npm 10.8.x to keep dependency resolution consistent across local, CI, and production environments.

1. Verify runtime versions:
   `node -v` (must be `>=20.19.0`)
   `npm -v` (must be `>=10.8.2`)
2. Install dependencies from lock-file:
   `npm ci`
3. Set the required environment variables in [.env.local](.env.local)
   - `VITE_API_BASE_URL=https://backend.example.com` (required for local `vite` dev server proxy; all frontend requests to `/api/*` are proxied to this backend URL).
   - `VITE_MEDIA_PUBLIC_BASE_URL=https://media.example.com[:port]` (required when ejabberd returns upload slots with `localhost` / `127.0.0.1` / `0.0.0.0` so clients can rewrite URLs to a public host).
   - `VITE_ALLOW_INSECURE_MEDIA_HTTP=false` (optional, default `false`; set to `true` only for local dev debugging when you intentionally need non-TLS media URLs)
4. (Optional) define runtime XMPP config in `index.html` before app bootstrap:
   - `window.__BRIDGE_XMPP_CONFIG = { domain: 'your-domain.tld', wsUrl: 'wss://your-domain.tld:5443/ws', mediaPublicBaseUrl: 'https://media.example.com' }`
   - runtime `mediaPublicBaseUrl` overrides `VITE_MEDIA_PUBLIC_BASE_URL`
   - use `wss://...` when TLS/reverse-proxy is enabled
   - `/upload` endpoints must be exposed via `https://` in production (client rejects non-TLS upload slots)
5. Run the app:
   `npm run dev`

### Dev-only emergency XMPP reconnect diagnostics

In **development mode only** (`import.meta.env.DEV`), the app exposes a minimal debug bridge:

- Namespace: `window.__bridgeDebug.xmpp`
- Safe methods:
  - `forceReconnectReset()` — resets only reconnect workflow guards/timers
  - `disconnectSoft()` — disconnects current session without clearing stored credentials in memory
  - `printReconnectState()` — prints sanitized reconnect state snapshot (no JID/password/keys/OMEMO state)

Usage in browser DevTools console:

```js
window.__bridgeDebug?.xmpp?.printReconnectState();
window.__bridgeDebug?.xmpp?.disconnectSoft();
window.__bridgeDebug?.xmpp?.forceReconnectReset();
```

Production builds do **not** publish this debug bridge.


### npm install crash on Windows (`Exit handler never called!`)

This is usually an npm CLI state/cache issue on Windows, not a project dependency problem.

Recommended recovery sequence (PowerShell):

```powershell
Remove-Item -Recurse -Force node_modules
npm cache verify
npm ci
```

If npm still crashes, update npm and retry:

```powershell
npm install -g npm@latest
npm ci
```

You can also use the repo helper script (cross-platform):

```bash
npm run reinstall
```

### npm proxy warning (`Unknown env config "http-proxy"`)

If `npm` prints `Unknown env config "http-proxy"`, your environment is exporting deprecated npm-specific variables.

Use supported proxy keys (`npm_config_proxy`, `npm_config_https_proxy`) and clear deprecated ones.

For one-off install/build commands:

```bash
env -u npm_config_http_proxy -u npm_config_https_proxy -u 'npm_config_http-proxy' -u 'npm_config_https-proxy' \
  npm_config_proxy="$HTTP_PROXY" npm_config_https_proxy="$HTTPS_PROXY" npm run build
```

### Vite prebundle cache troubleshooting (`chunk-*.js does not exist` / `strophe.js`)

If you see `chunk-*.js does not exist` or dev-server dependency optimization errors (especially around `strophe.js`), treat cache cleanup as mandatory:

1. Run: `npm run clean:vite`
2. Restart dev server: `npm run dev`
3. Hard-reload browser tab (disable cache in DevTools while reproducing).
4. If the error persists, check `services/xmppService.ts` import format for `strophe.js` and switch to a package-version-compatible style (default vs named export).

In development, the app also disables stale Service Worker/runtime caches automatically (unregisters SW + clears `bridge-*` caches), so old cached dev assets do not survive restarts.


## Ejabberd (23.10) server config

The repository includes a ready-to-use `ejabberd.yml` tailored for ejabberd **23.10** with WebSocket and HTTP Upload enabled. 

1. Copy `ejabberd.yml` to `/etc/ejabberd/ejabberd.yml`
2. Update `hosts`, `certfiles`, and `acl.admin.user`
3. Validate and restart ejabberd

See the full VPS setup guide here: [docs/vps-setup.md](docs/vps-setup.md)

- Подробная пошаговая инструкция на русском: [docs/server-checklist-ru.md](docs/server-checklist-ru.md)

> For end-user sign-up from the app, keep `mod_register` enabled in ejabberd (`XEP-0077` in-band registration).


## Security hardening

- Server hardening checklist: [docs/security-hardening.md](docs/security-hardening.md)

## Service Worker update flow and offline policy

- Client version is defined from a single source: `APP_VERSION` (CI/env), with fallback to `package.json` version in `vite.config.ts`.
- During build, `version.json` is emitted into the output directory and `sw.js` receives the same version value.
- Service worker cache name format: `bridge-<APP_VERSION>`.
- On `activate`, old `bridge-*` caches are deleted automatically.
- Fetch strategy:
  - `network-first` for navigations (`index.html`) with offline fallback to cached shell.
  - `stale-while-revalidate` for critical entries (`/`, `/index.html`, `/version.json`, `/assets/*`).
  - cache-first fallback for other same-origin GET requests.

### How app detects and applies a new version

1. App registers `/sw.js` and listens for `updatefound`.
2. If `registration.waiting` exists (or newly installed worker is waiting), app shows `Доступно обновление` with restart button.
3. Clicking restart sends `postMessage({ type: 'SKIP_WAITING' })` to the waiting worker.
4. App listens for `controllerchange` and safely performs `window.location.reload()` once.

### Offline behavior

- If network is unavailable, app shows offline banner and serves last cached shell/data where possible.
- `index.html` fallback is returned from cache when navigation requests fail.

### Cache headers for SW-related files

For local dev and preview, Vite is configured with non-aggressive cache headers:
- `Cache-Control: no-cache, no-store, must-revalidate`
- `Pragma: no-cache`
- `Expires: 0`

This avoids stale `sw.js`/`version.json` during rollout testing.
