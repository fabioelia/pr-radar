import assert from 'node:assert/strict';
import test from 'node:test';
import { cfg } from './fixture.js';
import { ENDED_DAYS, badgeLinks, diff, readNotice, settleEnded } from '../lib.js';

const row = (n, extra = {}) => ({ key: `acme/widgets#${n}`, repo: 'acme/widgets', number: n, title: `PR ${n}`, url: `https://github.com/acme/widgets/pull/${n}`, allLabels: [], checks: [], extracted: {}, attention: ['QA failed'], staleReports: { QA: 'abc' }, ...extra });
const DAY = 86_400_000;

test('a merged or closed PR is kept, cleared of what needed you', () => {
  const ended = settleEnded({}, [row(1), row(2), row(3)], new Set(), { 'acme/widgets#1': 'MERGED', 'acme/widgets#2': 'CLOSED', 'acme/widgets#3': 'OPEN' }, 1000);
  assert.deepEqual(Object.keys(ended).sort(), ['acme/widgets#1', 'acme/widgets#2']);
  assert.equal(ended['acme/widgets#1'].ended, 'MERGED');
  assert.deepEqual(ended['acme/widgets#1'].attention, []);
  assert.deepEqual(ended['acme/widgets#1'].staleReports, {});
});

test('an unknown state (the lookup failed) keeps nothing', () => {
  assert.deepEqual(settleEnded({}, [row(1)], new Set(), {}), {});
});

test('a reopened PR leaves, and old ones expire', () => {
  const now = 100 * DAY;
  const prev = { a: { endedAt: now - DAY }, b: { endedAt: now - (ENDED_DAYS + 1) * DAY }, c: { endedAt: now - DAY } };
  assert.deepEqual(Object.keys(settleEnded(prev, [], new Set(['c']), {}, now)), ['a']);
});

test('the notification says how a PR left', () => {
  const prev = [row(1), row(2), row(3), row(4)];
  const states = { 'acme/widgets#1': 'MERGED', 'acme/widgets#2': 'CLOSED', 'acme/widgets#3': 'OPEN' };
  const messages = diff(prev, [], cfg, new Set(), states).map((e) => e.message);
  assert.deepEqual(messages, ['Merged', 'Closed', 'No longer matches your searches', 'Left your list (merged or closed?)']);
});

test('a notification reads as its PR, its lines and the worst tone', () => {
  const n = readNotice({ title: 'acme/widgets#4977 fix(mdx): stop script', message: 'CI passed\nQA run failed: 2 defects\nQA run started' });
  assert.deepEqual(n.pr, { repo: 'acme/widgets', name: 'widgets', number: 4977 });
  assert.equal(n.title, 'fix(mdx): stop script');
  assert.deepEqual(n.lines.map((l) => l.tone), ['pass', 'fail', 'pending']);
  assert.equal(n.tone, 'fail');
  const plain = readNotice({ title: 'PR Radar test notification', message: 'If you can read this, notifications reach you.' });
  assert.equal(plain.pr, null);
  assert.equal(plain.title, 'PR Radar test notification');
  assert.equal(plain.tone, '');
});

test('badge links are the links of extractors marked badge, flagged when stale', () => {
  const config = { ...cfg, repos: { 'acme/widgets': { ...cfg.repos['acme/widgets'], extractors: [
    { name: 'Preview', source: 'body', regex: '(https://\\S+)', kind: 'link', badge: true },
    { name: 'Docs', source: 'body', regex: '(https://\\S+)', kind: 'link' },
    { name: 'Verdict', source: 'body', regex: 'x', kind: 'text', badge: true },
  ] } } };
  const r = row(1, { extracted: { Preview: ['https://a.example.com', 'https://b.example.com', 'https://c.example.com'], Docs: ['https://docs.example.com'], Verdict: ['ok'] }, staleReports: { Preview: 'abc' } });
  assert.deepEqual(badgeLinks(r, config), [
    { name: 'Preview', url: 'https://a.example.com', stale: true },
    { name: 'Preview', url: 'https://b.example.com', stale: true },
  ]);
  assert.deepEqual(badgeLinks(row(2, { extracted: {} }), config), []);
});
