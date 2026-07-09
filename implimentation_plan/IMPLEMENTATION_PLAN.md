# SLT Data Usage Widget — Implementation Plan

**Goal:** An always-on-desktop widget (Electron) that shows SLT data usage, alerts when usage is low/high, auto-launches on boot, and doesn't behave like a normal open app (no taskbar, no window chrome).

**Strategy:** Two-phase auth approach.
- **Phase 1** — System browser + one-time manual token paste (low risk, works today, ships first).
- **Phase 2** — Embedded window auto-capture (only attempted after a standalone feasibility test; falls back to Phase 1 if Google blocks embedded login).

Check off items as `[x]` as you complete them.

---

## Phase 0 — Auth Discovery ✅ COMPLETE

- [x] Open the API URL in incognito → confirmed 401 (auth required)
- [x] Capture a real request via DevTools → confirmed it's a **bearer token + client ID** scheme, not a session cookie
- [x] Identify required headers:
  - `Authorization: bearer <token>`
  - `X-IBM-Client-Id: b7402e9d66808f762ccedbe42c20668e`
  - (Origin/Referer must match `https://myslt.slt.lk` — API may check these)

**Outcome:** `config.json` will store a `headers` object, not a single cookie string.

---

## PHASE 1 — System Browser + Manual Paste (build this first, ship it)

### 1.1 Project scaffold
- [x] Create project folder `slt-widget/`
- [x] `npm init` → fill in `package.json` (name, main: `main.js`)
- [x] `npm install electron --save-dev`
- [x] `npm install electron-store node-notifier` (or use built-in `Notification`)
- [x] `npm install --save-dev electron-builder` (for later packaging)
- [x] Create `config.json` (gitignored) with shape:
  ```json
  {
    "subscriberID": "94372236361",
    "headers": {
      "Authorization": "",
      "X-IBM-Client-Id": "b7402e9d66808f762ccedbe42c20668e"
    },
    "refreshMinutes": 5,
    "warnThresholdPercent": 20,
    "criticalThresholdPercent": 10
  }
  ```
- [x] Add `.gitignore` (node_modules, config.json, dist/)

### 1.2 Main process (`main.js`)
- [x] Create borderless `BrowserWindow`: `frame: false`, `transparent: true`, `alwaysOnTop: true`, `skipTaskbar: true`, `resizable: false`
- [x] Position window (top-right corner or user-configurable x/y saved via `electron-store`)
- [x] `setVisibleOnAllWorkspaces(true)` so it survives virtual desktop switches
- [x] Load `index.html`
- [x] Set up polling loop (`setInterval`) using `refreshMinutes` from config
- [x] Fetch function: call the API with `subscriberID` + `headers` from config
- [x] Handle 401 response specifically → set an in-memory `authExpired` flag, push to renderer
- [x] IPC channel (`preload.js` with `contextBridge`) to safely pass fetched data to renderer (avoid `nodeIntegration: true` if possible — use contextIsolation properly)
- [x] `app.on('window-all-closed')` → do nothing (prevent quit); only quit via tray

### 1.3 Preload + secure IPC
- [x] `preload.js`: expose `window.api.onData(callback)`, `window.api.requestRefresh()`, `window.api.openTokenEntry()`
- [x] Switch main.js to `contextIsolation: true`, `nodeIntegration: false` using the preload bridge (safer than the quick-scaffold version)

### 1.4 Renderer UI (`index.html`)
- [x] Header row: "My SLT Usage" + small refresh icon + close(hide) icon
- [x] Three usage bars: **Standard/Main**, **Bonus**, **VAS**
  - [x] Show used/limit + unit (GB)
  - [x] Color states: green (>40% remaining), amber (15–40% remaining), red (<15% remaining)
- [x] Show expiry date (`31-Jul` style) and "reported at" timestamp
- [x] Draggable region (`-webkit-app-region: drag`) on the header, but **not** on buttons (`-webkit-app-region: no-drag` on buttons)
- [x] "Session expired — click to re-auth" banner state (shown when `authExpired` is true)
- [x] Loading / error states (network failure ≠ auth failure — show different messages)

### 1.5 Token entry flow (the "manual paste" part)
- [x] Small popup window or in-widget form: paste the `Authorization` bearer token (and client ID if it ever changes)
- [x] "How to get this" mini-instructions inside the popup:
  1. Log into `myslt.slt.lk` in your normal browser (Google login)
  2. Open DevTools → Network → filter `UsageSummary`
  3. Reload the usage page
  4. Copy the `Authorization` header value
  5. Paste here
- [x] Save token into `config.json` via `electron-store` (not plain file write, so it's OS-keychain-friendlier — see 1.9)
- [x] Trigger immediate refresh after saving new token

### 1.6 Alerting logic
- [x] Track last-notified threshold per data category in memory (avoid renotifying every poll)
- [x] Fire native `Notification` when remaining % crosses **warnThresholdPercent** (once)
- [x] Fire a second, more urgent notification at **criticalThresholdPercent** (once)
- [x] Reset "already notified" flags when a new billing cycle is detected (limit/used resets, i.e. used < previous used)
- [x] Visual-only fallback: red bar + pulsing dot even if OS notification permission is off

### 1.7 Tray icon
- [x] Add `tray-icon.png` (already have this asset)
- [x] Tray menu: **Refresh now**, **Re-enter token**, **Open MySLT portal (external browser)**, **Show/Hide widget**, **Quit**
- [x] Since window has no frame/taskbar entry, tray is the only way to quit — make sure `Quit` actually calls `app.quit()` (not just hide)

### 1.8 Auto-launch on boot
- [x] Add `auto-launch` npm package (cleaner than manual shortcut)
- [x] Toggle "Launch on startup" from tray menu, persisted in config
- [x] Manual fallback documented: drop a shortcut into `shell:startup` if the package approach has issues on the user's machine

### 1.9 Secure storage (small hardening pass)
- [x] Move token storage from raw `config.json` to `electron-store` (still plaintext on disk by default, but at least centralizes it)
- [x] Note in README: this is a personal-use token, don't commit `config.json` / don't share the built app with your token baked in

### 1.10 Packaging
- [x] Configure `electron-builder` in `package.json` (`build` field: `appId`, `win.target: nsis`, icon)
- [x] `npm run build` → produce installer `.exe`
- [x] Test installer on a clean run: Start Menu entry created, uninstall works
- [x] Confirm Windows Notifications work reliably from the **packaged** app (known to be flaky in dev/unpackaged mode)

### 1.11 Test pass (Phase 1 exit criteria)
- [x] Widget survives sleep/wake
- [x] Widget survives `explorer.exe` restart
- [x] Confirmed NOT in taskbar / NOT in Alt-Tab
- [x] Token entry flow works end-to-end (paste → save → refresh)
- [x] Auth-expired state displays correctly and re-entry flow recovers it
- [x] Threshold notifications fire once per crossing, not spammed every poll
- [x] Auto-launch confirmed after full PC restart (not just log-off)

**✅ Phase 1 done = you have a fully working, ship-quality widget.** Phase 2 is a pure UX improvement (removing the manual re-paste step) — optional, only pursue if Phase 1's token expiry cadence is annoying in practice.

---

## PHASE 2 — Embedded Window Auto-Capture (only after Phase 1 works)

### 2.1 Standalone feasibility test (build this in isolation, don't touch the main widget yet)
- [ ] New throwaway project `slt-auth-test/`
- [ ] Single `BrowserWindow` loading `https://myslt.slt.lk` login page
- [ ] Attach `session.webRequest.onBeforeSendHeaders` (or `onSendHeaders`) filtered to `*://omniscapp.slt.lk/*`
- [ ] Log any intercepted `Authorization` / `X-IBM-Client-Id` headers to console
- [ ] Attempt Google login manually inside this embedded window
- [ ] **Record outcome:**
  - [ ] ✅ Google login succeeds → proceed to 2.2
  - [ ] ❌ Google blocks with "This browser may not be secure" → **stop here, stay on Phase 1 permanently**, note it in this file

### 2.2 If feasible: integrate into main app
- [ ] Add a hidden/on-demand `BrowserWindow` (separate from the widget window) pointed at MySLT login
- [ ] Show this window only during initial setup or when re-auth is needed (not always-hidden — let user see they're logging in)
- [ ] On successful header capture, auto-save into config/electron-store, close the window
- [ ] Trigger immediate refresh of the main widget after capture

### 2.3 Auto-refresh of expiring tokens
- [ ] Determine token lifetime empirically (log timestamps of 401s during Phase 1 usage)
- [ ] Schedule a periodic hidden reload of the MySLT session (e.g. every N hours, before expected expiry)
- [ ] Re-intercept and re-save the refreshed header automatically
- [ ] Fallback: if hidden refresh also gets a 401/blocked, fall back to Phase 1's manual re-paste flow (don't let the app get stuck silently broken)

### 2.4 Test pass (Phase 2 exit criteria)
- [ ] Full cycle works with zero manual intervention across at least one natural token expiry
- [ ] Confirmed no repeated Google security prompts/blocks over several days of use
- [ ] Graceful fallback to manual paste confirmed if auto-refresh fails

---

## Open Risks / Notes (keep updated as you learn things)
- SLT's `X-IBM-Client-Id` is an IBM API Connect gateway client ID tied to their own frontend — reusing it is fine for personal use, don't redistribute the built app with real credentials embedded.
- Token lifetime unknown until observed in the wild — Phase 1 will surface this naturally via 401s.
- Google's embedded-webview OAuth block is a moving target; Phase 2's feasibility test result should be dated when recorded.

---

_Last updated: Phase 1 sections 1.1–1.11 done — 2026-07-09._
