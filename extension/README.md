# PR Radar

A Chrome side panel for keeping track of many open PRs and the Claude sessions behind them: CI and other checks, labels you care about, values pulled out of PR bodies and comments, and buttons for the actions you take most. It polls the GitHub API and nothing else; there is no server.

- **Side panel**: one section per search query, "needs you" PRs first. Each section folds from its header and has **Collapse all / Expand all**; each PR card folds to one line (title, a dot per check, number) with the chevron at its top right, and opens again with a click. Both are remembered. Each PR shows the checks you picked, your labels, links to its Claude sessions, and the links and text your extractors pull out of it (a preview URL, a review verdict). Filter box and a "Needs me" toggle.
- **Reports**: an extractor can read a QA report or a Playwright results comment into a block on the card (formats in [Reports](#reports)). QA lists its defects (with severity), the checks that failed, were blocked or were flaky, and its UX notes; passing checks are left out. Playwright shows progress while it runs ("Running 132 of 345"), then how many tests ran, passed, failed, were flaky or skipped, with the names of the failed and flaky tests. Each block links to its comment, and can download the run's artifacts (such as screenshots).
- **Stale flags**: a report or value made for an older commit than the PR's latest push gets a **stale** tag, in the panel and on both badges, with both commits on hover, and its "needs you" reason says "(stale)". A QA report names its commit, and a Playwright comment is matched through its Actions run (looked up once per run). For other extractors, `commit` is a regex for the commit a value was made for, such as a preview comment's commit line. Checks never go stale: they're always the latest commit's.
- **Check details**: click a card's background to see every check on the latest commit, failures first. Each failure shows GitHub's annotations (file:line and message), the check's summary, a **Log** button for Actions jobs (the 60 lines leading up to the first error, with error lines highlighted, rather than the post-job cleanup at the end), and re-run.
- **Toolbar badge**: how many PRs need you.
- **Live watching**: between refreshes, a PR with a check running that you get notified about (such as the QA run) is checked on its own every `watchSeconds` (30 by default) until the check lands, so its notification arrives within seconds instead of at the next refresh; the card shows **live**. The bell on a card watches that PR the same way and makes every change on it notify, not only the ones marked `notify`; the bell on a group's header watches every PR in the group, including PRs that join it later; turning one PR's bell off inside a watched group keeps that PR off (the group bell is then half-lit), and turning the group bell off unwatches the whole group. All watched PRs go in one small request; watching pauses only while the screen is locked. (A real GitHub webhook would need a public server for GitHub to call; this gets the same result from your machine.)
- **Desktop notifications** when something you marked `notify` changes: a label is added, a check finishes, an extracted value changes, a draft is marked ready, or a PR is merged, closed or leaves your list. Clicking one opens the PR. The inbox button at the top of the panel lists the last 30, with a count of new ones; click one to open its PR. Settings has a test button; see [Notifications](#notifications) if none arrive.
- **Follows your tabs**: on a PR page or a Claude session page, the panel highlights that PR, and scrolls to it once when you switch to that tab (never again on refresh, so it won't fight you while you scroll).
- **Reuses open tabs**: a PR link in the panel, the badge or a notification switches to a tab already showing that PR, or one of its pages such as Files, before opening a new one. Cmd/Ctrl/Shift/middle-click still open links the usual way.
- **Badge on claude.ai**: on a Claude Code session page (any claude.ai URL with a `session_…` ID), a small pill shows the PR(s) that link the session and their state. When none does, it says why in a muted pill: no token, no tracked repos, GitHub unreachable, or no PR links the session yet; hover for details, and the setup ones open settings. Drag it out of the way; the spot is remembered across pages. It matches PRs by the session ID, so the URL's path or query doesn't matter, and it reads only the page URL, never claude.ai's DOM. Reloading or updating the extension puts it back in claude.ai tabs that are already open.
- **Badge on GitHub**: on a PR page (any of its tabs), a pill links the Claude Code session(s) the PR mentions, and clicking one switches to the claude.ai tab already on that session before opening a new one. It works for any PR you open: one the panel tracks uses what the last refresh found, and any other is looked up on GitHub when you open it (remembered for five minutes). It only appears when the PR links a session.
- **Merged and closed PRs**: when a PR leaves your list, one small request asks GitHub why. A merged or closed PR then shows as **#123 Merged** or **#123 Closed** on its sessions' and preview pages' badges for 14 days, the GitHub badge tags its sessions the same way, and the notification says "Merged" or "Closed" (or "No longer matches your searches" for a PR that is still open).
- **Badges on preview pages**: list your preview site under **Badge pages** in settings (for example `https://*.preview.example.com/*`); saving asks Chrome to allow it. On a page a tracked PR links to (a link one of its extractors pulled out), the PR's badge (checks, stale notes, a link to the PR) and its Claude session badge show together. The badge only reads the address bar, so it never makes a request to the page; some preview hosts treat any request as activity and would stay awake.
- **Actions**: the first two buttons in a repo's list show on the card; the rest and the label picker sit under **More**. Add, remove or toggle a label (to request a review bot, say), mark a draft ready or convert it back to draft, close the PR, re-run a failed Actions job. **🏷 Labels…** opens a picker with every label in the repo, so you can add or remove any of them at once. Every write takes two clicks.
- **Artifacts**: clicking the QA verdict chip downloads that run's `qa-screenshots-pr<N>` artifact through your GitHub login in the browser. The artifact expires after 14 days.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick this `extension` folder.
2. Click the PR Radar icon to open the side panel, then ⚙ for settings.
3. Create a GitHub token ([fine-grained](#fine-grained-token) or [classic](#classic-token)), paste it, and click **Test token**. Test lists the repos the token can see; pick one and click **Check access** for a read-only check of each permission the panel uses.
4. Add the repos you track and save. The first poll runs right away.

If a permission is missing, the panel still shows what it could read and names each blocked field.

### Fine-grained token

1. Open [GitHub → Fine-grained tokens → Generate new token](https://github.com/settings/personal-access-tokens/new). Name it **PR Radar** and pick an expiration; you'll paste a new token into settings when it expires.
2. **Resource owner**: the organization that owns the repos you track. A fine-grained token covers one owner and the panel uses one token, so for repos under several owners use a classic token instead.
3. **Repository access**: **All repositories**, or **Only select repositories** with the ones you track.
4. **Permissions → Repositories → Add permissions**:

   | Permission | Access | Used for |
   |---|---|---|
   | Pull requests | Read and write | PRs and reviews; **Mark ready**, **Convert to draft**, **Close PR** |
   | Issues | Read and write | Comments (QA and Playwright reports, session links); adding and removing labels |
   | Contents | Read-only | A PR's commits, which is how its checks are found |
   | Commit statuses | Read-only | Status checks |
   | Actions | Read and write | Check results, job logs and screenshot downloads; **Re-run** |
   | Metadata | Read-only | Added by GitHub automatically |

   To only read, with no buttons, make every permission **Read-only**.
5. **Generate token** and paste it into settings. If the organization requires approval for fine-grained tokens, its repos don't appear in **Test token** until an owner approves.
6. **Check access** on one of your repos: every row should be green, and **Check runs** gray. GitHub doesn't let fine-grained tokens call the Checks API ([a listed limitation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)), so the panel reads the same results from the Actions API; see [Where checks come from](#where-checks-come-from).

### Classic token

[Create a classic token with the `repo` scope](https://github.com/settings/tokens/new?scopes=repo&description=PR%20Radar). It covers every repo you can reach and every check, including ones that aren't Actions jobs (such as a status posted by a review app). If an organization uses SAML single sign-on, click **Configure SSO** next to the token and authorize that organization.

The token is kept in `chrome.storage.local` for this browser profile, and shared with the Mac app when it's installed (next section).

### Where settings are kept

- **In the extension:** Chrome's extension storage, which survives restarts. The extension has a fixed ID (the `key` in `manifest.json`), so loading it from a different folder keeps its settings; removing the extension deletes them.
- **Shared with the Mac app:** when the [menu bar app](../mac/) is installed, the extension and the app share one copy: the config in `~/Library/Application Support/PR Radar/config.json`, the token in the macOS keychain (item **PR Radar**). The app registers a small helper with Chrome (and Chromium, Brave, Edge and Arc if present) each time it starts; Chrome's native messaging is the only way an extension can reach a file on disk. Saving in either one updates the other. The extension picks up the app's changes when it starts, on every refresh, and when you open settings. Settings shows which mode you're in. If the app isn't reachable when you save, the change is sent the next time it is. The helper only answers the extension ID listed in its registration, but an unpacked extension's ID comes from the public key in its manifest, so it says which extension this is, not who wrote it: only load extensions you trust in a browser where the app is installed.
- **Export / Import:** **Export** in settings writes the config to a JSON file, and asks whether to include the token. **Import** loads one into the form for you to review and save. Use it for a backup, or for another browser profile.

## Configure

**Only the repos you set up are tracked.** Every search is limited to them (with `repo:` qualifiers), and PRs from any other repo are ignored. Each repo has its own labels, checks, extractors and buttons; searches and the General settings are shared. Under **Repos you track**, add a repo (it autocompletes from the repos your token can see), starting from the basics (an "All checks" summary chip, Claude session links, draft/ready/close buttons) or as a copy of a repo you already set up.

The settings page has a **Form** tab and a **JSON** tab that edit the same config. In the form, every section has **+ Add**, ↑/↓ to reorder, ✕ to delete and a list of presets. When you pick a repo to edit, its labels and recent check names load, and the label and check-name fields autocomplete from them. Check names are typed as plain names; `*` means every check, and `/pattern/` is a regex. The JSON tab is there for copying a config to someone else or for anything the form doesn't cover. **Reset to defaults** loads `DEFAULT_CONFIG` from `lib.js`: two searches and no repos.

**Sharing a setup with a team:** set it up once, **Export** it without the token, and share the file. Teammates **Import** it, review it and save, then add their own token.

The JSON fields:

| Key | What it does |
|---|---|
| `pollMinutes` | Minutes between polls while a check is running (minimum 0.5). Each search is one GraphQL call; GitHub allows 5,000 points an hour. |
| `quietPollMinutes` | Minutes between polls once every check has settled (default 10). |
| `watchSeconds` | Seconds between checks of watched PRs (default 30, at least 5). |
| `autoWatch` | Watch a PR while a check or report that notifies is in progress (default on). |
| `checksSource` | `auto` (default), `checks` or `actions`. See **Where checks come from** below. |
| `queries[]` | `{title, q}`: GitHub search syntax, one panel section each, limited to the repos in `repos`. A PR in several shows under the first. |
| `repos` | `{"owner/name": {labels, checks, extractors, actions}}`: the repos you track, each with the four lists below. |
| `labels[]` (per repo) | `{name, kind, notify}`: `kind` is `alert` (counts as "needs you"), `ok`, `pending` or `info`. Labels not listed stay hidden unless `showOtherLabels` is true. |
| `checks[]` (per repo) | `{label, match, rollup, notify, showTitle, alertTitle}`: `match` is a regex on the check name. If one name has several runs, the newest one that wasn't skipped counts. `rollup: true` sums every matching check into one chip, worst state first. `showTitle` shows the check's output title; `alertTitle` is a regex on that title that counts as "needs you". |
| `extractors[]` (per repo) | `{name, report, source, contains, regex, all, kind, notify, artifacts, alert}`: `report: "qa"` or `"playwright"` parses the newest text holding `contains` into a report block (no regex needed). Otherwise pulls values out of the PR body (`body`), comments and review bodies (`comments`), or both (`all`). `contains` limits it to texts holding a marker. It takes capture group 1 if there is one, else the whole match. `all: true` keeps every match, otherwise the newest. `kind` is `link` or `text`. `artifacts` is a regex on artifact names: the chip then downloads the matching artifacts of the Actions run linked from the same text (the last `/actions/runs/<id>` link in it). |
| `actions[]` (per repo) | `{title, type, label, when}`: `type` is `addLabel`, `removeLabel`, `toggleLabel`, `markReady`, `convertToDraft` or `close`. `when` is `draft` or `ready`. An add button hides when the label is already there, and a remove button when it isn't; a toggle shows `+` or `−`. |
| `badgePages[]` | `{match}`: Chrome match patterns for other sites that show the PR badge, such as `https://*.preview.example.com/*`. Saving asks Chrome to allow each one. |
| `attention` | `{failedChecks, changesRequested, conflicts}`: other things that count as "needs you". |

Examples:

```json
{ "title": "Bot PRs I'm on", "q": "is:pr is:open author:app/my-bot involves:@me" }
```

```json
{ "name": "Jira", "source": "body", "regex": "\\[([A-Z]+-\\d+)\\]", "kind": "text" }
```

## Reports

An extractor with `report` reads the newest comment holding its `contains` marker into a block on the card, instead of a single value. Two formats are built in, for comments a bot keeps updating on the PR:

- **`qa`**, a QA report. A verdict alert (`> [!CAUTION]`, `[!WARNING]` or `[!TIP]`, then `> **verdict**`, with the tested commit as ``head `abc1234` ``), a table of checks whose ❌ failed, ⛔ blocked and ⚠️ flaky rows are kept, a `### QA-1 · high — title` heading per defect, and `- **UX-1 · title**` bullets under a "UX notes" heading.
- **`playwright`**, Playwright results. `⏳ **Running…** 132/345 tests` and `**So far:** 120 passed, 2 failed, 1 flaky, 9 skipped` while running, `**Stats:** 340 passed, 3 failed, 2 skipped, 1 flaky · ran in 14m` once done, and `#### Failed Tests:` / `#### :warning: Flaky` lists of ``- **title** (`file`)`` lines. Its commit comes from its Actions run: a `run-id: 123` marker, or the last run it links.

## Where checks come from

With a classic token, checks come from GitHub's Checks API inside the main GraphQL query. A fine-grained token can't call that API (GitHub lists it as a fine-grained token limitation), and gets `null` back for each check run. In `auto` mode the panel then reads the PR's head commit from the **Actions API**. Every Actions job is also a check run with the same name, so configured check names match either way, and the jobs API adds the name of the failed step.

The Actions path only asks GitHub for what can have changed:

- **A finished run is fetched once.** Its jobs are reused until a re-run changes its `updated_at`.
- **A settled PR costs nothing.** When every run on the head commit has finished, its run list isn't asked for again until the PR changes (a push or a label bumps its `updatedAt`) or 10 minutes pass, which is how a manual re-run gets picked up.
- **Everything else is a conditional request.** It carries the last ETag, and GitHub doesn't count the 304 it answers with against the hourly limit.
- **The cache lives in `chrome.storage.session`.** Chrome stops an idle extension worker within about 30 seconds, long before the next poll, so an in-memory cache would be empty every time.
- **Polling follows activity:** every `pollMinutes` while a check is running, every `quietPollMinutes` once everything has settled, and not at all while the computer is locked or idle for 10 minutes. It polls as soon as you're back.

The panel header shows the REST and GraphQL requests left this hour.

What the Actions API can't see: check runs that aren't Actions jobs, such as a status a review app posts or the summary `CodeQL` check, and failure annotations. When such a check's verdict is also written into a PR comment, an extractor can read it from there with either token.

## Notifications

PR Radar notifies when something changes between two refreshes: a label or check marked `notify` changes, an extractor marked `notify` gets a new value, a draft is marked ready, a PR joins or leaves your list. A PR with its bell on notifies on every change. The very first refresh, after installing or after settings were reset, only records the current state, so nothing notifies until something changes after it.

If none arrive, open **Settings → Notifications**:

1. **The status line** says whether Chrome lets PR Radar notify. If it says blocked, allow it at `chrome://settings/content/notifications`.
2. **Send a test notification.** If it doesn't appear, the system is hiding it. On macOS, open **System Settings → Notifications → Google Chrome** (the menu bar app draws its own; see [its README](../mac/README.md)), turn on **Allow notifications** and pick **Banners** or **Alerts**. A Focus mode such as Do Not Disturb also holds them back.
3. **Recent notifications** (also the panel's inbox button) lists the last 30 PR Radar sent. If the test appears but this list stays empty while your PRs change, nothing you track is marked `notify`: tick **Notify** on the labels, checks and extractors you care about (**Settings → Form**), or turn on a card's bell.

## What it doesn't do, and why

- **No preview probing.** PR Radar never requests a preview or any other page it shows a badge on: some preview hosts count every request as activity, so polling them would keep every preview awake. What it shows about a preview comes from GitHub: its deploy check and the link in the PR.
- **No live Claude session status** (working, blocked, idle). claude.ai has no public API for it, and scraping its pages would break whenever its UI changes. Sessions appear because a PR links them: the `## Agent session` section of the PR body, or any comment that contains a session URL.
- **Raw PR bodies are never stored.** Only extracted values are kept. Don't write an extractor that captures a secret, such as a token a deploy bot writes into the PR body.
- **PRs a bot opens for you** don't match `author:@me`. Add a query for them, like the example above.

## Develop

```bash
npm test
```

runs the unit tests for `lib.js` (Node 20+, no dependencies). The other files are plain ES modules with no build step: edit them, then click reload on `chrome://extensions`.

| File | Role |
|---|---|
| `lib.js` | Default config, GraphQL query, normalization, "needs you" rules, change detection, tab matching |
| `github.js` | GitHub API calls and the token access check |
| `background.js` | Polling, badge, notifications, write actions |
| `builder.js` | The settings form, generated from its `SECTIONS` table |
| `theme.css` | Color tokens (light and dark) and the button, input, pill and switch styles both pages share |
| `dom.js` | The text-only element helper and the icon set both pages use |
| `sidepanel.*` | The panel |
| `options.*` | Settings page: token, form and JSON editor, export and import |
| `shared.js` | Keeps config and token in step with the Mac app over native messaging |
| `content.js` | The badges on claude.ai session, GitHub PR and preview pages |
