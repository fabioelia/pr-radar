# PR Radar for the Mac menu bar

PR Radar in the menu bar: an icon showing how many PRs need you, and the same panel as the Chrome extension in a popover under it. Cards, check details, logs, QA and Playwright reports, labels, buttons and settings all work as in the extension.

It runs the extension's own code. `npm start` and `npm run dist` copy the pages and logic from `../extension` into `ext/`, and `shim.js` supplies the `chrome.*` calls they make (storage, messages, alarms, idle, notifications, the badge) on Electron. Change the extension, rebuild, and the app follows.

## Run it

From this folder, on your Mac (Node 20 or later):

```bash
npm install
```

```bash
npm start
```

The radar icon appears in the menu bar. Click it for the panel, right-click for Refresh, Settings…, **Open at login** and Quit. Open **Settings…** and paste your GitHub token (the [extension README](../extension/README.md#fine-grained-token) has step-by-step setup for a fine-grained or classic token), add the repos you track, and save.

## Build the app

```bash
npm run dist
```

This writes a `.dmg` and a `.zip` to `dist/`. Drag **PR Radar** to Applications. The app isn't signed with an Apple Developer ID, so the first launch needs **right-click → Open → Open**. If macOS says the app "is damaged", clear the quarantine flag and open it again:

```bash
xattr -cr "/Applications/PR Radar.app"
```

## How it differs from the extension

- **Settings are shared with the extension.** The app keeps the config in `~/Library/Application Support/PR Radar/config.json` and the token in your macOS keychain (item **PR Radar**). Each time it starts, it registers a helper (`dev.prradar.host`) with Chrome, Chromium, Brave, Edge and Arc if they're installed, so the extension reads and writes the same copy. A change saved in either shows up in the other. Settings saved by an earlier version of the app move there on first launch. The rest of the app's state (the last poll, the cache) stays in `storage.bin`, encrypted with the keychain.
- **Links open in your browser.** A PR link first looks for a Chrome tab already showing that PR and switches to it, through AppleScript. The first time, macOS asks to let PR Radar control Google Chrome; if you decline, links simply open a new tab in your default browser.
- **The current-PR highlight** follows the front Chrome tab, read when you open the panel.
- **Artifact downloads** open in your browser, which has your GitHub login.
- **Notifications are PR Radar cards.** macOS delivers an Electron app's notifications only when the app is signed with an Apple developer certificate, and drops them silently otherwise. So unless the app is signed that way, it draws its own: a card in the top-right corner of the screen with the pointer, colored by what changed, that opens the PR when clicked. A card closes after 8 seconds (15 for a failure); hovering keeps it open and × dismisses it. They don't go to Notification Center or follow Focus modes; settings lists the recent ones. A build signed with a Developer ID or Apple Development certificate (`CSC_NAME` for `npm run dist`) uses macOS notifications instead, listed under **PR Radar** in System Settings → Notifications.
- **No claude.ai badge.** That lives in the browser, so it stays an extension feature.

`npm test` runs the tests for the shared store and the helper.

## Files

| File | Role |
|---|---|
| `main.js` | Menu bar icon, the popover and settings windows, the bridge between them and the background code |
| `toast.html`, `toast.js`, `toast-preload.cjs` | The notification cards, for builds macOS won't deliver notifications for |
| `shim.js` | The `chrome.*` API on Electron: storage (keychain-encrypted), alarms, idle, notifications, badge, Chrome tabs over AppleScript |
| `preload.cjs` | Gives the pages `chrome.*` and sends their GitHub requests through the main process (a page outside an extension hits CORS on the job-log download) |
| `shared-store.cjs` | The shared settings: `config.json` and the keychain item |
| `host.cjs` | The native messaging helper Chrome starts for the extension |
| `copy-ext.mjs` | Copies the extension's files into `ext/` |
| `assets/` | Menu bar template icons and the app icon |
