# PR Radar

Keep track of many open PRs, the CI checks on them, and the Claude Code sessions behind them, without hunting through GitHub tabs.

- **[`extension/`](extension/)**: a Chrome extension. A side panel lists your open PRs in the repos you track. Each card shows its checks, labels, Claude session links, and parsed QA and Playwright results. Clicking a card shows every check, with failure annotations and log tails. Each card also has buttons to request reviews, toggle labels, mark ready or draft, close the PR, and re-run jobs. It also shows a badge on claude.ai session pages with the session's PR status, and sends desktop notifications when something changes.
- **[`mac/`](mac/)**: the same panel as a macOS menu bar app (Electron), behind an icon showing how many PRs need you.

Each folder's README covers setup: the GitHub token it needs, the settings, and how to build.

```bash
cd extension && npm test
```

runs the unit tests (Node 20+, no dependencies).
