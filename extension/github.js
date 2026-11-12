// GitHub API calls shared by the service worker and the settings page.
import { CONCLUSION, QUERY, allChecks, checksHidden, flattenContexts, logTail, mapLimit, summarizeErrors, touchesChecks } from './lib.js';

const API = 'https://api.github.com';

// The REST limit as of the last response: GitHub sends it on every one.
let restLimit = null;
export const restRate = () => restLimit;

// GitHub answers 502/503/504 now and then (its jobs endpoint on big runs, a
// GraphQL query that ran too long), and sometimes a 200 whose body isn't
// JSON. A GET and a GraphQL query are safe to repeat, so they get two more
// tries; a mutation, which changes something, never does.
const RETRY_DELAYS = [1000, 3000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request with the retries. `etag` makes it conditional: GitHub answers
// 304 when nothing changed, and a 304 doesn't count against the hourly limit.
async function send(token, path, { method = 'GET', body, etag } = {}) {
  const repeatable = method === 'GET' || (path === '/graphql' && !/^\s*mutation\b/.test(body?.query || ''));
  let res;
  let data = null;
  let unreadable = false;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = res.status === 204 || res.status === 304 ? '' : await res.text();
    unreadable = false;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
      unreadable = true;
    }
    // A 2xx must carry JSON (except 204/304); one that doesn't is a failure.
    if (res.ok && res.status !== 204 && res.status !== 304 && data === null) unreadable = true;
    const transient = [502, 503, 504].includes(res.status) || (res.ok && unreadable);
    if (!repeatable || !transient || attempt >= RETRY_DELAYS.length) break;
    await sleep(RETRY_DELAYS[attempt]);
  }
  if (res.headers.get('x-ratelimit-resource') === 'core') {
    restLimit = {
      remaining: Number(res.headers.get('x-ratelimit-remaining')),
      limit: Number(res.headers.get('x-ratelimit-limit')),
      reset: Number(res.headers.get('x-ratelimit-reset')) * 1000,
    };
  }
  if (res.status === 304) return { notModified: true, etag };
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: ${res.status} ${data?.message || ''}`.trim());
  if (unreadable) throw new Error(`${method} ${path.split('?')[0]}: ${res.status} with a body that isn't JSON`);
  // GraphQL answers 200 with partial data when the token can't read some
  // fields (a fine-grained token missing a permission); only fail outright
  // when nothing came back.
  if (data?.errors?.length && !data.data) throw new Error(summarizeErrors(data.errors));
  return { data, etag: res.headers.get('etag') || '' };
}

export async function gh(token, path, opts) {
  return (await send(token, path, opts)).data;
}

export const DRAFT_MUTATIONS = {
  markReady: 'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }',
  convertToDraft: 'mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { clientMutationId } }',
};

export const graphql = (token, query, variables) => gh(token, '/graphql', { method: 'POST', body: { query, variables } });

// Classic tokens report their scopes in a header; fine-grained ones don't.
export async function whoami(token) {
  const res = await fetch(`${API}/user`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token rejected: ${res.status} ${body.message || ''}`.trim());
  const scopes = res.headers.get('x-oauth-scopes');
  return {
    login: body.login,
    kind: scopes === null ? 'fine-grained' : 'classic',
    scopes: scopes || '',
    expires: res.headers.get('github-authentication-token-expiration') || '',
  };
}

// Every repo the token can see, most recently pushed first. ponytail: stops
// at 500; past that the list is for eyeballing, not completeness.
export async function listRepos(token) {
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(token, `/user/repos?per_page=100&sort=pushed&page=${page}`);
    repos.push(...batch.map((r) => r.full_name));
    if (batch.length < 100) break;
  }
  return repos;
}

// Read-only probes of what the panel needs from one repo, so a missing
// permission shows up by name instead of as "Resource not accessible".
// Write access can't be probed without writing, so it isn't.
export async function diagnose(token, repo) {
  const results = [];
  const probe = async (name, need, fn) => {
    try {
      results.push({ name, ok: true, detail: await fn() });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message, need });
    }
  };
  let pr = null;
  await probe('Pull requests', 'Pull requests: read', async () => {
    [pr] = await gh(token, `/repos/${repo}/pulls?state=all&per_page=1`);
    return pr ? `latest is #${pr.number}` : 'repo has no PRs, so the probes below are skipped';
  });
  if (pr) {
    const sha = pr.head.sha;
    await probe('Comments', 'Issues: read (or Pull requests: read)', async () => {
      await gh(token, `/repos/${repo}/issues/${pr.number}/comments?per_page=1`);
      return 'readable';
    });
    await probe('Commit statuses', 'Commit statuses: read', async () => {
      const s = await gh(token, `/repos/${repo}/commits/${sha}/status`);
      return `${s.total_count} on #${pr.number}`;
    });
    await probe('Check runs', "Checks: read, which fine-grained tokens can't have. Not required: the panel reads Actions jobs instead (next row)", async () => {
      const c = await gh(token, `/repos/${repo}/commits/${sha}/check-runs?per_page=1`);
      return `${c.total_count} on #${pr.number}`;
    });
    await probe('Actions jobs', 'Actions: read', async () => {
      const r = await gh(token, `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=1`);
      return `${r.total_count} workflow runs on #${pr.number}`;
    });
  }
  await probe('Panel query', '', async () => {
    const { errors = [] } = await graphql(token, QUERY, { q: `repo:${repo} is:pr`, n: 1 });
    // Hidden check runs are covered by the Actions API when that works, so
    // on their own they aren't a failure of the panel's query.
    const actionsOk = results.find((r) => r.name === 'Actions jobs')?.ok;
    const checkRuns = results.find((r) => r.name === 'Check runs');
    if (actionsOk && checkRuns && !checkRuns.ok && checkRuns.detail.includes(' 403 ')) {
      Object.assign(checkRuns, { ok: true, info: true, detail: "Not available to fine-grained tokens, and not needed: the panel reads check results from the Actions API (next row)." });
    }
    const blocking = actionsOk ? errors.filter((e) => !touchesChecks(e)) : errors;
    if (blocking.length) throw new Error(summarizeErrors(blocking));
    return errors.length ? 'readable; check runs come from the Actions API (row above)' : 'every field readable';
  });
  return results;
}

// ponytail: stops at 300 labels.
export async function listLabels(token, repo) {
  const names = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh(token, `/repos/${repo}/labels?per_page=100&page=${page}`);
    names.push(...batch.map((l) => ({ name: l.name, color: l.color })));
    if (batch.length < 100) break;
  }
  return names;
}

export const CHECKS_QUERY = `
query Checks($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name status conclusion title summary detailsUrl startedAt
                    checkSuite { workflowRun { workflow { name } } }
                    annotations(first: 5) { nodes { path message annotationLevel location { start { line } } } }
                  }
                  ... on StatusContext { context state description targetUrl createdAt }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

// How long a PR whose runs have all finished goes without its run list being
// checked again. Pushes and label changes bump the PR's updatedAt and are
// seen at once; this only bounds how late a manual re-run shows up.
const SETTLED_RECHECK_MS = 10 * 60 * 1000;

function jobContexts(run, jobs) {
  return jobs.map((j) => {
    const failedStep = j.steps?.find((st) => st.conclusion === 'failure');
    return {
      name: j.name,
      state: j.status !== 'completed' ? 'pending' : CONCLUSION[(j.conclusion || '').toUpperCase()] || 'neutral',
      title: failedStep ? `Failed at: ${failedStep.name}` : '',
      url: j.html_url,
      at: j.started_at || '',
      summary: '',
      workflow: run.name,
      annotations: [],
    };
  });
}

// An empty Actions cache. The service worker keeps one in
// chrome.storage.session because Chrome stops an idle worker within about
// 30 seconds, long before the next poll.
export const emptyActionsCache = () => ({ runs: {}, jobs: {} });

// The head commit's Actions jobs in the shape flattenContexts returns. Each
// Actions job is also a check run with the same name, so configured check
// names match either way. Requests are skipped where `cache` shows nothing
// can have changed: a finished run's jobs are reused until a re-run bumps
// its updated_at, and a PR whose runs have all finished isn't re-listed
// until the PR changes or SETTLED_RECHECK_MS passes. Every entry read or
// written is marked `seen` so the caller can drop the rest.
export async function actionsContexts(token, repo, sha, cache = emptyActionsCache(), prUpdatedAt = '') {
  if (!sha) return [];
  const key = `${repo}@${sha}`;
  const prev = cache.runs[key];
  const settled = prev?.runs.every((r) => r.status === 'completed');
  let entry = prev;
  if (!(settled && prev.prUpdatedAt === prUpdatedAt && Date.now() - prev.at < SETTLED_RECHECK_MS)) {
    const res = await send(token, `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, { etag: prev?.etag });
    const runs = res.notModified
      ? prev.runs
      : res.data.workflow_runs.map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, updated: r.updated_at }));
    entry = { runs, etag: res.etag, at: Date.now(), prUpdatedAt };
    cache.runs[key] = entry;
  }
  entry.seen = true;
  // Fully skipped runs only add skipped entries, so they aren't expanded.
  const live = entry.runs.filter((r) => r.conclusion !== 'skipped');
  // Two at a time per PR (the poll runs four PRs at once): firing every
  // run's jobs request together is what draws GitHub's 502s.
  const perRun = await mapLimit(live, 2, async (run) => {
    const hit = cache.jobs[run.id];
    if (hit && run.status === 'completed' && hit.updated === run.updated && hit.done) {
      hit.seen = true;
      return hit.contexts;
    }
    const res = await send(token, `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, { etag: hit?.etag });
    const contexts = res.notModified ? hit.contexts : jobContexts(run, res.data.jobs);
    cache.jobs[run.id] = { updated: run.updated, done: run.status === 'completed', etag: res.etag, contexts, seen: true };
    return contexts;
  });
  return perRun.flat();
}

// Drops entries the last poll didn't touch (merged PRs, old commits) and
// clears the marks for the next one.
export function pruneActionsCache(cache) {
  for (const table of [cache.runs, cache.jobs]) {
    for (const [k, v] of Object.entries(table)) {
      if (v.seen) delete v.seen;
      else delete table[k];
    }
  }
  return cache;
}

// The side panel lives as long as it's open, so a plain object works there.
const panelCache = emptyActionsCache();

// The text a PR's session links can be in, for a PR the panel isn't
// tracking (the GitHub badge asks about any PR you open).
export const PR_TEXT_QUERY = `
query PrText($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state body
      comments(last: 100) { nodes { body } }
      reviews(last: 30) { nodes { body } }
    }
  }
}`;

export async function prTexts(token, repo, number) {
  const [owner, name] = repo.split('/');
  const { data } = await graphql(token, PR_TEXT_QUERY, { owner, name, number });
  const pr = data?.repository?.pullRequest;
  if (!pr) return { texts: [], state: '' };
  return { texts: [pr.body, ...[...(pr.comments?.nodes || []), ...(pr.reviews?.nodes || [])].filter(Boolean).map((c) => c.body)], state: pr.state };
}

// OPEN, MERGED or CLOSED for each PR node ID; a PR that can't be read is left out.
export const PR_STATES_QUERY = `
query PrStates($ids: [ID!]!) {
  nodes(ids: $ids) { ... on PullRequest { id state } }
}`;
export async function prStates(token, ids) {
  const { data } = await graphql(token, PR_STATES_QUERY, { ids });
  return Object.fromEntries((data?.nodes || []).filter((n) => n?.id).map((n) => [n.id, n.state]));
}

export async function prChecks(token, row) {
  if (row.checksFrom !== 'actions') {
    const { data, errors } = await graphql(token, CHECKS_QUERY, { id: row.id });
    if (!data?.node) throw new Error(errors?.length ? summarizeErrors(errors) : 'PR not found');
    if (!checksHidden(data.node)) return { checks: allChecks(flattenContexts(data.node)), warning: errors?.length ? summarizeErrors(errors) : '' };
  }
  return {
    checks: allChecks(await actionsContexts(token, row.repo, row.sha, panelCache, row.updatedAt)),
    warning: '',
    note: 'From the Actions API: Actions jobs only, no annotations. A classic token adds the rest.',
  };
}

// The API answers with a redirect to a signed log URL on Azure blob storage,
// which is why manifest.json lists those hosts.
export async function jobLog(token, repo, jobId) {
  const res = await fetch(`${API}/repos/${repo}/actions/jobs/${jobId}/logs`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Log unavailable: ${res.status}${res.status === 404 || res.status === 410 ? ' (expired or still running)' : ''}`);
  return logTail(await res.text());
}

// Check names seen on a repo's recent PRs, for the settings form to suggest.
// Falls back to the newest PR's Actions jobs when check runs are hidden.
export async function checkNames(token, repo) {
  const { data } = await graphql(token, QUERY, { q: `repo:${repo} is:pr sort:updated-desc`, n: 10 });
  const prs = data.search.nodes.filter(Boolean);
  let names = prs.flatMap((pr) => flattenContexts(pr).map((c) => c.name));
  if (!names.length && prs[0]?.headRefOid) names = (await actionsContexts(token, repo, prs[0].headRefOid)).map((c) => c.name);
  return [...new Set(names)].sort();
}
