// The native messaging helper Chrome starts for the extension: one request
// in, one reply out, over stdin/stdout in Chrome's framing (a 4-byte
// little-endian length, then JSON). Chrome only starts it for the extension
// ID listed in its manifest, which the app writes (main.js, installHost).
//   { type: 'get' }                → { ok, config, token, updatedAt, file }
//   { type: 'set', config?, token? } → { ok, updatedAt, file }
const { create } = require('./shared-store.cjs');

const store = create(process.env.PR_RADAR_DIR);

function reply(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]), () => process.exit(0));
}

function handle(msg) {
  try {
    if (msg.type === 'get') return reply({ ok: true, ...store.get(), file: store.file });
    if (msg.type === 'set') {
      const saved = store.set({ config: msg.config, token: msg.token }, 'extension');
      return reply({ ok: true, updatedAt: saved.updatedAt, file: store.file });
    }
    reply({ ok: false, error: `unknown request ${msg.type}` });
  } catch (e) {
    reply({ ok: false, error: String(e.message || e) });
  }
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (buf.length < 4) return;
  const n = buf.readUInt32LE(0);
  if (buf.length < 4 + n) return;
  let msg;
  try {
    msg = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
  } catch {
    return reply({ ok: false, error: 'not JSON' });
  }
  handle(msg);
});
process.stdin.on('end', () => buf.length < 4 && process.exit(0));
