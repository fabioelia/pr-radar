// The settings the Mac app and the Chrome extension share: the config in
// <dir>/config.json, the GitHub token in the macOS keychain. The app uses
// this directly; the extension reaches it through host.cjs. CommonJS, because
// host.cjs runs it under plain Node (Electron with ELECTRON_RUN_AS_NODE).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVICE = 'PR Radar';
const ACCOUNT = 'github-token';

// The keychain, through the `security` tool: both the app and the helper
// Chrome starts can use it, which Electron's safeStorage (app only) can't.
// Elsewhere, and in tests, the token goes in a file only you can read.
const keychain = process.platform === 'darwin' && !process.env.PR_RADAR_NO_KEYCHAIN;

function create(dir) {
  const file = path.join(dir, 'config.json');
  const tokenFile = path.join(dir, 'token.secret');

  function read() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function getToken() {
    if (keychain) {
      const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : '';
    }
    try {
      return fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      return '';
    }
  }

  function setToken(token) {
    if (keychain) {
      if (!token) {
        spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
        return;
      }
      // Given on stdin (`security -i`), so the token never shows in a process list.
      const quoted = token.replace(/["\\]/g, '\\$&');
      const r = spawnSync('security', ['-i'], { input: `add-generic-password -U -s "${SERVICE}" -a "${ACCOUNT}" -w "${quoted}"\n`, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`Could not save the token to the keychain: ${r.stderr || r.status}`);
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    if (!token) return fs.rmSync(tokenFile, { force: true });
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    fs.chmodSync(tokenFile, 0o600);
  }

  // { config, token, updatedAt, tokenUpdatedAt }. config is null until either
  // side has saved settings.
  function get() {
    const s = read();
    return { config: s?.config ?? null, token: getToken(), updatedAt: s?.updatedAt || 0, tokenUpdatedAt: s?.tokenUpdatedAt || 0 };
  }

  // Writes whichever of config and token is given; `by` records the writer.
  // The file is replaced in one rename, so a reader never sees half of it.
  function set({ config, token }, by) {
    const prev = read() || {};
    if (token !== undefined) setToken(token);
    const now = Date.now();
    const next = {
      version: 1,
      updatedAt: now,
      updatedBy: by,
      tokenUpdatedAt: token !== undefined ? now : prev.tokenUpdatedAt || 0,
      config: config !== undefined ? config : (prev.config ?? null),
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
    return next;
  }

  return { dir, file, read, get, set, getToken };
}

module.exports = { create };
