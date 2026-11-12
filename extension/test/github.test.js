import assert from 'node:assert/strict';
import test from 'node:test';
import { actionsContexts, emptyActionsCache, pruneActionsCache } from '../github.js';

// A fake GitHub: answers the two Actions endpoints from `state`, honors
// If-None-Match with 304, and records every request.
function fakeGitHub(state) {
  const calls = [];
  globalThis.fetch = async (url, { headers }) => {
    const path = url.replace('https://api.github.com', '');
    let body;
    if (path.includes('/actions/runs?head_sha=')) body = { workflow_runs: state.runs };
    else body = { jobs: state.jobs[path.match(/runs\/(\d+)\/jobs/)[1]] };
    const etag = `"${JSON.stringify(body).length}-${JSON.stringify(body)}"`;
    const notModified = headers['If-None-Match'] === etag;
    calls.push(`${notModified ? '304' : '200'} ${path.split('?')[0]}`);
    return new Response(notModified ? null : JSON.stringify(body), { status: notModified ? 304 : 200, headers: { etag } });
  };
  return calls;
}

const run = (id, status, conclusion, updated = 't1') => ({ id, name: `wf${id}`, status, conclusion, updated_at: updated });
const job = (name, status, conclusion) => ({ name, status, conclusion, html_url: `https://github.com/o/r/actions/runs/1/job/${name}`, started_at: 't' });

test('a settled PR costs nothing on the next poll; a running one re-asks only for its running run', async () => {
  const state = {
    runs: [run(1, 'completed', 'success'), run(2, 'in_progress', null), run(3, 'completed', 'skipped')],
    jobs: { 1: [job('lint', 'completed', 'success')], 2: [job('test', 'in_progress', null)] },
  };
  const calls = fakeGitHub(state);
  const cache = emptyActionsCache();
  const first = await actionsContexts('t', 'o/r', 'sha1', cache, 'u1');
  assert.deepEqual(first.map((c) => `${c.name}:${c.state}`), ['lint:pass', 'test:pending']);
  assert.deepEqual(calls.splice(0), ['200 /repos/o/r/actions/runs', '200 /repos/o/r/actions/runs/1/jobs', '200 /repos/o/r/actions/runs/2/jobs']);

  // Nothing changed: the run list and the running run's jobs come back 304,
  // and the finished run isn't asked for at all.
  await actionsContexts('t', 'o/r', 'sha1', cache, 'u1');
  assert.deepEqual(calls.splice(0), ['304 /repos/o/r/actions/runs', '304 /repos/o/r/actions/runs/2/jobs']);

  // The running run finishes.
  state.runs[1] = run(2, 'completed', 'failure', 't2');
  state.jobs[2] = [job('test', 'completed', 'failure')];
  const done = await actionsContexts('t', 'o/r', 'sha1', cache, 'u1');
  assert.deepEqual(done.map((c) => `${c.name}:${c.state}`), ['lint:pass', 'test:fail']);
  assert.deepEqual(calls.splice(0), ['200 /repos/o/r/actions/runs', '200 /repos/o/r/actions/runs/2/jobs']);

  // Everything settled and the PR untouched: zero requests.
  const again = await actionsContexts('t', 'o/r', 'sha1', cache, 'u1');
  assert.deepEqual(calls.splice(0), []);
  assert.deepEqual(again, done);

  // A label change bumps the PR's updatedAt, so the run list is checked again.
  await actionsContexts('t', 'o/r', 'sha1', cache, 'u2');
  assert.deepEqual(calls.splice(0), ['304 /repos/o/r/actions/runs']);
});

test('a re-run of a finished run is fetched again; pruning drops what the last poll did not touch', async () => {
  const state = { runs: [run(1, 'completed', 'failure')], jobs: { 1: [job('test', 'completed', 'failure')] } };
  const calls = fakeGitHub(state);
  const cache = emptyActionsCache();
  await actionsContexts('t', 'o/r', 'sha1', cache, 'u1');
  calls.length = 0;
  // A re-run bumps updated_at; the PR itself doesn't change, so it shows
  // up once the settled re-check is due (simulated by aging the entry).
  cache.runs['o/r@sha1'].at -= 11 * 60 * 1000;
  state.runs[0] = run(1, 'completed', 'success', 't9');
  state.jobs[1] = [job('test', 'completed', 'success')];
  const after = await actionsContexts('t', 'o/r', 'sha1', cache, 'u1');
  assert.equal(after[0].state, 'pass');
  assert.deepEqual(calls.splice(0), ['200 /repos/o/r/actions/runs', '200 /repos/o/r/actions/runs/1/jobs']);

  pruneActionsCache(cache);
  assert.deepEqual(Object.keys(cache.runs), ['o/r@sha1']);
  pruneActionsCache(cache);
  assert.deepEqual(cache, emptyActionsCache());
});
