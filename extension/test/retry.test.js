import assert from 'node:assert/strict';
import test from 'node:test';
import { DRAFT_MUTATIONS, graphql } from '../github.js';

// Answers in order, then the last one forever; records each request.
function fakeGitHub(...answers) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body).query.trim().split(/\s/)[0]);
    const [status, body] = answers[Math.min(seen.length - 1, answers.length - 1)];
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return seen;
}

test('a GraphQL query that times out is tried again', async () => {
  const seen = fakeGitHub([504, '{"message":"timeout"}'], [504, ''], [200, '{"data":{"ok":1}}']);
  const r = await graphql('t', 'query Q { ok }', {});
  assert.deepEqual(r.data, { ok: 1 });
  assert.equal(seen.length, 3);
});

test('a mutation is never repeated', async () => {
  const seen = fakeGitHub([504, ''], [200, '{"data":{}}']);
  await assert.rejects(graphql('t', DRAFT_MUTATIONS.markReady, { id: 'x' }), /504/);
  assert.equal(seen.length, 1);
});

test('a 200 with no JSON is retried, then reported, never read as data', async () => {
  const seen = fakeGitHub([200, ''], [200, '<html>gateway</html>'], [200, '']);
  await assert.rejects(graphql('t', 'query Q { ok }', {}), /body that isn't JSON/);
  assert.equal(seen.length, 3);
});
