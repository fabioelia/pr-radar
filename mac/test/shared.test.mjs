import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
process.env.PR_RADAR_NO_KEYCHAIN = '1';
const { create } = require('../shared-store.cjs');
const HOST = new URL('../host.cjs', import.meta.url).pathname;

test('config goes to config.json and the token never does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prr-'));
  const store = create(dir);
  assert.deepEqual(store.get(), { config: null, token: '', updatedAt: 0, tokenUpdatedAt: 0 });
  const saved = store.set({ config: { pollMinutes: 3 }, token: 'ghp_secret' }, 'app');
  const file = readFileSync(join(dir, 'config.json'), 'utf8');
  assert.ok(!file.includes('ghp_secret'));
  assert.equal(JSON.parse(file).updatedBy, 'app');
  assert.equal(statSync(join(dir, 'token.secret')).mode & 0o777, 0o600);
  assert.deepEqual(store.get(), { config: { pollMinutes: 3 }, token: 'ghp_secret', updatedAt: saved.updatedAt, tokenUpdatedAt: saved.tokenUpdatedAt });
  // Saving only the config keeps the token and its timestamp.
  const again = store.set({ config: { pollMinutes: 5 } }, 'extension');
  assert.equal(store.get().token, 'ghp_secret');
  assert.equal(again.tokenUpdatedAt, saved.tokenUpdatedAt);
  store.set({ token: '' }, 'app');
  assert.equal(store.get().token, '');
});

function ask(dir, msg) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST, 'chrome-extension://abc/'], { env: { ...process.env, PR_RADAR_DIR: dir } });
    const body = Buffer.from(JSON.stringify(msg));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    let out = Buffer.alloc(0);
    child.stdout.on('data', (c) => (out = Buffer.concat([out, c])));
    child.on('error', reject);
    child.on('exit', (code) => {
      const n = out.readUInt32LE(0);
      assert.equal(out.length, 4 + n, 'one framed reply');
      resolve({ code, reply: JSON.parse(out.subarray(4).toString()) });
    });
    child.stdin.end(Buffer.concat([head, body]));
  });
}

test('the native host answers get and set in Chrome framing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prr-'));
  const set = await ask(dir, { type: 'set', config: { queries: [] }, token: 'ghp_x' });
  assert.equal(set.code, 0);
  assert.equal(set.reply.ok, true);
  assert.equal(set.reply.file, join(dir, 'config.json'));
  const get = await ask(dir, { type: 'get' });
  assert.deepEqual([get.reply.config, get.reply.token, get.reply.updatedAt], [{ queries: [] }, 'ghp_x', set.reply.updatedAt]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).updatedBy, 'extension');
  const bad = await ask(dir, { type: 'nope' });
  assert.deepEqual(bad.reply, { ok: false, error: 'unknown request nope' });
});
