// A small badge pinned to two kinds of page, each pointing at the other:
// - a Claude Code session (any claude.ai URL with a session_ ID): the PR(s)
//   that link the session and their check states (or Merged / Closed, for
//   14 days after one leaves your list that way), or, muted, why there are
//   none;
// - a GitHub PR: the Claude session(s) the PR links, and whether it was
//   merged or closed, shown only when it links one;
// - a page a tracked PR links to, such as its preview deployment, on a site
//   listed in settings' badge pages (background.js registers this script
//   there): both, the PR and its sessions, shown only for a tracked PR.
// It reads only location.href, never the page's DOM, so neither site's UI
// changes can break it. Drag it anywhere; each site remembers its own spot.
(() => {
  const onGitHub = location.host === 'github.com';
  const onClaude = location.host === 'claude.ai';
  const POS_KEY = onGitHub ? 'badgePositionGitHub' : onClaude ? 'badgePosition' : 'badgePositionLinked';
  // Injected again after an extension reload (background.js, reinjectBadge):
  // the old copy can no longer reach the extension, so its badge goes.
  for (const old of document.querySelectorAll('pr-radar-badge')) old.remove();
  const COLOR = { pass: '#3fb950', fail: '#ff6b6b', cancelled: '#ff6b6b', pending: '#e5a23b', neutral: '#8b949e', skipped: '#8b949e' };
  const MARGIN = 8;
  const host = document.createElement('pr-radar-badge');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .wrap { position: fixed; z-index: 2147483647; display: flex; flex-direction: column; gap: 4px; font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; touch-action: none; }
    .badge { user-select: none; display: flex; align-items: center; gap: 8px; max-width: 420px; padding: 5px 12px 5px 6px; border-radius: 999px; background: rgba(22, 27, 34, 0.94); color: #e6edf3; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); backdrop-filter: blur(6px); }
    .badge.needs { background: rgba(130, 20, 32, 0.95); }
    .badge.muted { background: rgba(22, 27, 34, 0.72); color: #c9d1d9; padding-right: 10px; font-weight: 500; }
    .badge.muted.action { cursor: pointer; }
    .badge.muted.action:hover { background: rgba(22, 27, 34, 0.9); }
    .brand { width: 8px; height: 8px; border-radius: 50%; background: #5b9dff; flex: none; }
    .grip { cursor: grab; color: #8b949e; padding: 2px 3px; letter-spacing: -2px; user-select: none; }
    .wrap.dragging .grip, .wrap.dragging .badge { cursor: grabbing; }
    a { color: inherit; text-decoration: none; display: flex; align-items: center; gap: 8px; min-width: 0; }
    a:hover .num { text-decoration: underline; }
    .num { font-weight: 700; }
    .reason { color: #ffb4b4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
    .checks { display: flex; gap: 7px; white-space: nowrap; overflow: hidden; }
    .check { display: inline-flex; align-items: center; gap: 4px; color: #c9d1d9; }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
    .claude { width: 8px; height: 8px; border-radius: 50%; background: #d97757; flex: none; }
    .label { color: #c9d1d9; font-weight: 500; }
    .session { font-weight: 700; }
    .sep { color: #6e7681; }
    .stale { color: #e5a23b; font-weight: 600; white-space: nowrap; }
    .state { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; color: #fff; white-space: nowrap; }
    .state.merged { background: #8957e5; }
    .state.closed { background: #b62324; }
    .ended .title { color: #c9d1d9; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
  </style><div class="wrap"></div>`;
  const wrap = root.querySelector('.wrap');
  let pos = { right: 16, bottom: 88 };
  let lastUrl = '';

  const place = () => {
    const w = wrap.offsetWidth || 200;
    const h = wrap.offsetHeight || 30;
    pos.right = Math.min(Math.max(MARGIN, pos.right), Math.max(MARGIN, innerWidth - w - MARGIN));
    pos.bottom = Math.min(Math.max(MARGIN, pos.bottom), Math.max(MARGIN, innerHeight - h - MARGIN));
    wrap.style.right = `${pos.right}px`;
    wrap.style.bottom = `${pos.bottom}px`;
  };

  // A press that moves more than a few pixels is a drag, and the click it
  // ends in must not open the link.
  let drag = null;
  let dragged = false;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, right: pos.right, bottom: pos.bottom };
    dragged = false;
  });
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    dragged = true;
    wrap.classList.add('dragging');
    pos = { right: drag.right - dx, bottom: drag.bottom - dy };
    place();
  });
  addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    wrap.classList.remove('dragging');
    if (dragged) chrome.storage.local.set({ [POS_KEY]: pos }).catch(() => {});
  });
  addEventListener('resize', place);
  wrap.addEventListener('click', (e) => {
    const setup = e.target.closest('.action');
    if (setup && !dragged) return chrome.runtime.sendMessage({ type: 'openSettings' }).catch(() => {});
    const a = e.target.closest('a');
    if (!a) return;
    if (dragged) {
      e.preventDefault();
      dragged = false;
      return;
    }
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'open', url: a.href }).catch(() => open(a.href, '_blank'));
  });

  const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text ? { textContent: text } : {});

  const STATE = { MERGED: 'merged', CLOSED: 'closed' };
  const stateTag = (state) => el('span', `state ${STATE[state]}`, STATE[state] === 'merged' ? 'Merged' : 'Closed');

  // A PR merged or closed since it left your list: its state, not its checks.
  function endedBadge(r) {
    const row = el('div', 'badge ended');
    row.append(el('span', 'grip', '⋮⋮'));
    const a = el('a');
    a.href = r.url;
    a.draggable = false;
    a.title = `${r.title}\n${STATE[r.ended] === 'merged' ? 'Merged' : 'Closed'} ${new Date(r.endedAt).toLocaleString()}`;
    a.append(el('span', 'num', `#${r.number}`), stateTag(r.ended), el('span', 'title', r.title));
    row.append(a);
    return row;
  }

  function badge(r) {
    if (r.ended) return endedBadge(r);
    const row = el('div', `badge${r.attention.length ? ' needs' : ''}`);
    row.append(el('span', 'grip', '⋮⋮'));
    const a = el('a');
    a.href = r.url;
    a.draggable = false;
    a.title = [r.title, ...r.attention].join('\n');
    a.append(el('span', 'num', `#${r.number}${r.isDraft ? ' draft' : ''}`));
    if (r.attention.length) a.append(el('span', 'reason', r.attention.join(' · ')));
    const checks = el('span', 'checks');
    for (const c of r.checks.filter((c) => c.state !== 'missing')) {
      const item = el('span', 'check');
      const dot = el('span', 'dot');
      dot.style.background = COLOR[c.state] || COLOR.neutral;
      item.append(dot, c.label);
      checks.append(item);
    }
    a.append(checks);
    const stale = Object.keys(r.staleReports || {});
    if (stale.length) a.append(staleNote(stale));
    row.append(a);
    return row;
  }

  // Reports shown for an older commit than the PR's latest push.
  function staleNote(names) {
    const note = el('span', 'stale', names.length === 1 ? `${names[0]} stale` : `${names.length} stale`);
    note.title = `${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} made for an older commit than the PR's latest push.`;
    return note;
  }

  // Shown instead of PRs, so a missing badge never has to be guessed at.
  const NONE = {
    'no-token': ['PR Radar: add your GitHub token', 'Click to open PR Radar settings.', true],
    'no-repos': ['PR Radar: add the repos you track', 'Only repos set up in PR Radar settings are tracked. Click to open them.', true],
    error: ["PR Radar can't reach GitHub", '', true],
    loading: ['PR Radar: loading…', '', false],
    ok: [
      'No PR links this session yet',
      "PR Radar shows a PR here once one links this session (the session URL in its description or a comment), and the PR is in your searches and a repo you track.",
      false,
    ],
  };
  function none(setup, error) {
    const [text, why, action] = NONE[setup] || NONE.ok;
    const row = el('div', `badge muted${action ? ' action' : ''}`);
    row.title = error || why;
    row.append(el('span', 'grip', '⋮⋮'), el('span', 'brand'), el('span', '', text));
    return row;
  }

  const shortId = (url) => url.match(/session_([A-Za-z0-9]{1,6})/)?.[1] || '';

  // GitHub: links to the PR's Claude sessions.
  function sessionBadge(sessions, stale, state) {
    const row = el('div', 'badge');
    row.append(el('span', 'grip', '⋮⋮'));
    if (STATE[state]) row.append(stateTag(state));
    if (!sessions.length) {
      row.append(staleNote(stale));
      return row;
    }
    row.append(el('span', 'claude'), el('span', 'label', sessions.length === 1 ? 'Claude session' : 'Claude sessions'));
    sessions.forEach((url, i) => {
      if (i) row.append(el('span', 'sep', '·'));
      const a = el('a');
      a.href = url;
      a.draggable = false;
      a.title = `Open ${url}`;
      a.append(el('span', 'session num', shortId(url)));
      row.append(a);
    });
    if (stale.length) row.append(el('span', 'sep', '·'), staleNote(stale));
    return row;
  }

  // The badges for this page, or null to show none.
  async function badgesFor(url) {
    if (onGitHub) {
      const pr = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
      if (!pr) return null;
      const res = await chrome.runtime.sendMessage({ type: 'sessionsFor', repo: `${pr[1]}/${pr[2]}`, number: Number(pr[3]) });
      // Shown when the PR links a session, or when the reports on this page
      // were made for an older commit than its latest push.
      const sessions = res?.sessions || [];
      const stale = res?.stale || [];
      return sessions.length || stale.length ? [sessionBadge(sessions, stale, res?.state)] : null;
    }
    if (!onClaude) {
      // A page a tracked PR links to (its preview): the PR, then its sessions.
      const res = await chrome.runtime.sendMessage({ type: 'match', url });
      const rows = res?.rows || [];
      return rows.length ? rows.flatMap((r) => [badge(r), ...(r.sessions?.length ? [sessionBadge(r.sessions, [])] : [])]) : null;
    }
    if (!/\bsession_[A-Za-z0-9]+/.test(url)) return null;
    const res = await chrome.runtime.sendMessage({ type: 'match', url });
    const rows = res?.rows || [];
    return rows.length ? rows.map(badge) : [none(res?.setup, res?.error)];
  }

  let timer = null;
  async function update() {
    const url = location.href;
    lastUrl = url;
    let badges;
    try {
      badges = await badgesFor(url);
    } catch {
      // The extension was reloaded or removed: this copy is cut off for good.
      clearInterval(timer);
      return host.remove();
    }
    if (location.href !== url) return; // navigated on while waiting
    if (!badges) return host.remove();
    wrap.replaceChildren(...badges);
    if (!host.isConnected) document.documentElement.append(host);
    place();
  }

  // Both sites are single-page apps: watch for client-side navigation.
  timer = setInterval(() => location.href !== lastUrl && update(), 1500);
  chrome.storage.onChanged.addListener((c) => {
    if (c.snapshot) update();
    if (c[POS_KEY]?.newValue && !drag) {
      pos = c[POS_KEY].newValue;
      place();
    }
  });
  chrome.storage.local
    .get(POS_KEY)
    .then((got) => got[POS_KEY] && (pos = got[POS_KEY]))
    .catch(() => {})
    .finally(update);
})();
