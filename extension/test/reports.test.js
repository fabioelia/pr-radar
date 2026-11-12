import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePlaywrightReport, parseQaReport, reportSummary } from '../lib.js';

// Synthetic comments in the shapes the two report parsers read.
const QA = `## 🧪 QA — PR #1234

> [!CAUTION]
> **🐞 2 defects in 9 checks.** Steps 1–6 pass. · 2 UX notes
> develop · 2026-11-11 · regular user \`qa\` · head \`abc1234\`

| | Check | Lens | Evidence |
|:-:|---|---|---|
| ✅ | Step 1: the chart renders | UI | \`01.png\` |
| ❌ | A component with an \`onError\` attribute saves and fails to load | API | QA-1 |
| ❌ | Reload keeps the **links** | state | QA-2 |
| ⛔ | Same flow over MCP | parity | not testable, see below |
| ⚠️ | Export finishes | UI | 2 of 3 |

### 🐞 QA-1 · major — An accepted component renders as "failed to load"

| | |
|---|---|
| **Expected** | refused |

### QA-2 · minor — Links lose their target after a reload

### 💡 UX notes

- **UX-1 · Raw fallback hides the valid parts**: the whole reply renders as code.
- **UX-2 · "Breaking" note vs what users see** (read from code): reword it.

<details><summary>Suggested regression tests</summary>

- **QA-1 (pytest):** not a UX note.
</details>

<!-- qa-report -->`;

test('the QA report keeps defects, failed/blocked/flaky checks and UX notes, and drops passing checks', () => {
  const r = parseQaReport(QA);
  assert.equal(r.tone, 'CAUTION');
  assert.equal(r.verdict, '🐞 2 defects in 9 checks.');
  assert.deepEqual(r.defects, [
    { id: 'QA-1', severity: 'major', title: 'An accepted component renders as "failed to load"' },
    { id: 'QA-2', severity: 'minor', title: 'Links lose their target after a reload' },
  ]);
  assert.deepEqual(r.checks, [
    { kind: 'fail', title: 'A component with an onError attribute saves and fails to load' },
    { kind: 'fail', title: 'Reload keeps the links' },
    { kind: 'blocked', title: 'Same flow over MCP' },
    { kind: 'flaky', title: 'Export finishes' },
  ]);
  assert.deepEqual(r.ux, [
    { id: 'UX-1', title: 'Raw fallback hides the valid parts' },
    { id: 'UX-2', title: '"Breaking" note vs what users see' },
  ]);
  assert.equal(reportSummary(r), '🐞 2 defects · 1 blocked · 1 flaky · 2 UX notes');
});

test('a clean QA report summarizes as clean', () => {
  const r = parseQaReport('> [!TIP]\n> **✅ 5 checks pass.**\n\n| | Check |\n|:-:|---|\n| ✅ | All good |');
  assert.deepEqual([r.defects, r.checks, r.ux], [[], [], []]);
  assert.equal(reportSummary(r), '✅ Clean');
});

const PW_FINAL = `### Playwright Test Results

❌ Tests **failed — this blocks merge (the \`Playwright Success\` check is required)**

**Stats:** 240 passed, 2 failed, 99 skipped, 3 flaky · ran in 12m 00s

#### Failed Tests:
- :x: **BLA_01: Verify the sidebar opens:: Given a run** (\`blueprints/sidebar.spec.ts\`)
  > Error: expect(locator).toBeVisible() failed
  :link: [Open the failing page in the environment](https://example.com)
- :x: **HO_16: Verify Manage Access search** (\`home/smoke.spec.ts\`)

#### :warning: Flaky (3 — passed on retry, did NOT block the gate):
- **CO_02: Verify a reply streams** (\`conversation/stream.spec.ts\`)
- **CO_03: Verify quote replies** (\`conversation/quote.spec.ts\`)
- **CO_04: Verify export** (\`conversation/export.spec.ts\`)

<!-- playwright-results -->`;

test('a finished Playwright run gives counts, failed and flaky tests', () => {
  const r = parsePlaywrightReport(PW_FINAL);
  assert.equal(r.state, 'failed');
  assert.deepEqual([r.passed, r.failed, r.skipped, r.flaky, r.total, r.duration], [240, 2, 99, 3, 344, '12m 00s']);
  assert.deepEqual(r.failedTests.map((t) => t.file), ['blueprints/sidebar.spec.ts', 'home/smoke.spec.ts']);
  assert.equal(r.failedTests[0].title, 'BLA_01: Verify the sidebar opens:: Given a run');
  assert.equal(r.flakyTests.length, 3);
  assert.equal(reportSummary(r), '❌ 240/245 passed · 2 failed · 3 flaky');
});

test('a running Playwright run gives progress and failures so far', () => {
  const r = parsePlaywrightReport(`### Playwright Test Results

⏳ **Running…** 120/345 tests · 10/40 suites · running for 4m 10s

\`██████░░░░░░░░░░░░░░\` 35%

**So far:** 117 passed, 1 failed, 2 flaky, 0 skipped

#### Failing so far:
- :x: **HO_16: Verify Manage Access search** (\`home/smoke.spec.ts\`)
`);
  assert.deepEqual([r.state, r.done, r.total, r.passed, r.failed, r.flaky], ['running', 120, 345, 117, 1, 2]);
  assert.deepEqual(r.failedTests, [{ title: 'HO_16: Verify Manage Access search', file: 'home/smoke.spec.ts' }]);
  assert.equal(reportSummary(r), '⏳ Running 120/345 · 1 failed so far');
});

test('a passed run and a skipped run summarize plainly', () => {
  const passed = parsePlaywrightReport('✅ Tests **passed**\n\n**Stats:** 244 passed, 0 failed, 99 skipped, 2 flaky · ran in 12m 00s\n');
  assert.equal(reportSummary(passed), '✅ 244/246 passed · 2 flaky');
  const skipped = parsePlaywrightReport('### Playwright Test Results\n⏭️ Playwright E2E tests were **skipped** for this PR via the checkbox.');
  assert.equal(reportSummary(skipped), 'Skipped');
});
