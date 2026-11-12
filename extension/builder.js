// The settings form: one editable list per config section, generated from
// SECTIONS. It edits a plain config object and calls onChange after every
// edit; options.js keeps the JSON tab in step. Searches and General are
// shared; the other sections edit the repo picked under "Repos you track".
import { h, icon } from './dom.js';
import { DEFAULT_CONFIG as D, NEW_REPO_PROFILE, nameToRegex, regexToName } from './lib.js';

// Presets: what a new repo starts with, plus common starting points to edit.
const EXAMPLES = {
  labels: [
    { name: 'do not merge', kind: 'alert', notify: true },
    { name: 'needs review', kind: 'pending' },
    { name: 'approved', kind: 'ok', notify: true },
  ],
  checks: [
    { label: 'CI', match: '^CI$', notify: true },
    { label: 'Gate', match: '^review/gate$', showTitle: true, notify: true },
  ],
  extractors: [
    { name: 'QA', report: 'qa', source: 'comments', contains: '<!-- qa-report -->', notify: true },
    { name: 'Playwright', report: 'playwright', source: 'comments', contains: '<!-- playwright-results -->', notify: true, alert: 'failed' },
  ],
  actions: [{ title: 'Request review', type: 'addLabel', label: 'needs review', when: 'ready' }],
};
const byTitle = (key, title) => {
  const items = [...NEW_REPO_PROFILE[key], ...EXAMPLES[key]];
  return [...new Map(items.map((it) => [it[title], it])).entries()];
};

export const SECTIONS = [
  {
    key: 'queries',
    shared: true,
    title: 'Searches',
    help: 'Each search is one section of the panel, in GitHub search syntax (@me means you). Every search is limited to the repos you track.',
    fields: [
      { k: 'title', label: 'Section name', ph: 'My PRs' },
      { k: 'q', label: 'GitHub search', ph: 'is:pr is:open author:@me', wide: true },
    ],
    presets: [
      ...D.queries.map((q) => [q.title, q]),
      ['PRs I’m involved in', { title: 'Involved', q: 'is:pr is:open involves:@me archived:false' }],
      ['Bot PRs I’m on', { title: 'Bot PRs', q: 'is:pr is:open author:app/BOT-NAME involves:@me' }],
      ['Everything open in a repo', { title: 'Repo', q: 'is:pr is:open repo:OWNER/REPO' }],
    ],
  },
  {
    key: 'badgePages',
    shared: true,
    title: 'Badge pages',
    help: 'Sites besides claude.ai and GitHub that show the PR badge, such as your preview deployments. A page shows the badge of the tracked PR that links to it (a link pulled out of its PR text). Saving asks Chrome to allow each site; the badge never loads anything from it.',
    fields: [{ k: 'match', label: 'Pages', ph: 'https://*.preview.example.com/*', wide: true }],
    presets: [],
    blank: { match: '' },
  },
  {
    key: 'labels',
    title: 'Labels to watch',
    help: 'Cards show these labels. "Needs me" labels flag the PR and count on the toolbar badge.',
    fields: [
      { k: 'name', label: 'Label', list: 'dl-labels' },
      { k: 'kind', label: 'Means', type: 'select', options: [['alert', 'Needs me'], ['ok', 'Good'], ['pending', 'In progress'], ['info', 'Info']] },
      { k: 'notify', label: 'Notify when added', type: 'checkbox' },
    ],
    presets: byTitle('labels', 'name'),
    blank: { name: '', kind: 'info' },
  },
  {
    key: 'checks',
    title: 'Checks to show',
    help: 'Type a check name exactly as GitHub shows it (it autocompletes), * for every check, or /a pattern/. "Sum up" turns all matches into one chip.',
    fields: [
      { k: 'label', label: 'Short name', ph: 'CI' },
      { k: 'match', label: 'Check name', list: 'dl-checks', wide: true, toUi: regexToName, fromUi: nameToRegex },
      { k: 'rollup', label: 'Sum up every match', type: 'checkbox' },
      { k: 'notify', label: 'Notify when it finishes', type: 'checkbox' },
      { k: 'showTitle', label: 'Show its result text', type: 'checkbox' },
      { k: 'alertTitle', label: 'Needs me if the text matches', ph: 'Not recommended', optional: true, showIf: (r) => r.showTitle },
    ],
    presets: byTitle('checks', 'label'),
    blank: { label: '', match: '' },
  },
  {
    key: 'extractors',
    title: 'Pull out of PR text',
    help: 'Reads links, text or a whole report out of the PR description and comments. Start from a preset.',
    fields: [
      { k: 'name', label: 'Name' },
      { k: 'report', label: 'Read as', type: 'select', options: [['', 'A pattern (regex)'], ['qa', 'QA report'], ['playwright', 'Playwright results']] },
      { k: 'source', label: 'Look in', type: 'select', options: [['all', 'Description + comments'], ['body', 'Description'], ['comments', 'Comments']] },
      { k: 'regex', label: 'Pattern (regex; group 1 is kept)', wide: true, showIf: (r) => !r.report },
      { k: 'contains', label: 'Only in texts containing', optional: true },
      { k: 'kind', label: 'Show as', type: 'select', options: [['link', 'Link'], ['text', 'Text']], showIf: (r) => !r.report },
      { k: 'all', label: 'Every match', type: 'checkbox', showIf: (r) => !r.report },
      { k: 'notify', label: 'Notify on change', type: 'checkbox' },
      { k: 'badge', label: 'Show on badges', type: 'checkbox', showIf: (r) => !r.report && r.kind === 'link' },
      { k: 'artifacts', label: 'Click downloads artifacts named', ph: '^qa-screenshots', optional: true },
      { k: 'alert', label: 'Needs me if the value matches', ph: '⛔', optional: true },
      { k: 'commit', label: 'Commit it was made for (regex; group 1)', ph: '"sha":"([0-9a-f]{7,40})"', optional: true, showIf: (r) => !r.report },
    ],
    presets: [
      ...byTitle('extractors', 'name'),
      ['Jira keys', { name: 'Jira', source: 'body', regex: '\\[([A-Z][A-Z0-9]+-\\d+)\\]', all: true, kind: 'text' }],
      ['Links to a site…', 'site'],
    ],
    blank: { name: '', source: 'all', regex: '', kind: 'text' },
  },
  {
    key: 'actions',
    title: 'Buttons',
    help: 'Buttons on each card. Every one asks for a second click before it writes to GitHub.',
    fields: [
      { k: 'title', label: 'Button text' },
      {
        k: 'type',
        label: 'Does',
        type: 'select',
        options: [['toggleLabel', 'Toggle a label'], ['addLabel', 'Add a label'], ['removeLabel', 'Remove a label'], ['markReady', 'Mark ready'], ['convertToDraft', 'Convert to draft'], ['close', 'Close the PR']],
      },
      { k: 'label', label: 'Label', list: 'dl-labels', showIf: (r) => r.type?.endsWith('Label') },
      { k: 'when', label: 'Show on', type: 'select', options: [['', 'Any PR'], ['draft', 'Drafts'], ['ready', 'Ready PRs']] },
    ],
    presets: byTitle('actions', 'title'),
    blank: { title: '', type: 'toggleLabel', label: '' },
  },
];

// Empty strings and false checkboxes are left out, so the saved JSON stays
// as short as the hand-written defaults.
function setField(row, f, raw) {
  const v = f.type === 'checkbox' ? raw : f.fromUi && raw ? f.fromUi(raw) : raw;
  if (v === '' || v === false) delete row[f.k];
  else row[f.k] = v;
}

function control(row, f, onChange, rerender) {
  const shown = f.toUi && row[f.k] ? f.toUi(row[f.k]) : row[f.k] ?? '';
  if (f.type === 'checkbox') {
    const change = (e) => {
      setField(row, f, e.target.checked);
      onChange();
      rerender(); // a switch can show or hide another field (showIf)
    };
    return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!row[f.k], onchange: change }), f.label);
  }
  const input =
    f.type === 'select'
      ? h('select', {}, f.options.map(([v, t]) => h('option', { value: v }, t)))
      : h('input', { type: 'text', placeholder: f.optional ? `Optional${f.ph ? `, e.g. ${f.ph}` : ''}` : f.ph || '', list: f.list });
  input.value = shown;
  input.addEventListener(f.type === 'select' ? 'change' : 'input', () => {
    setField(row, f, input.value);
    onChange();
    if (f.type === 'select') rerender();
  });
  return h('label', { class: `field${f.wide ? ' wide' : ''}` }, h('span', {}, f.label), input);
}

function siteExtractor() {
  const site = prompt('Collect links to which site? (e.g. jira.example.com)');
  if (!site) return null;
  const host = site.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return { name: host, source: 'all', regex: `https://${host.replace(/\./g, '\\.')}/[^\\s)>\\]"']+`, all: true, kind: 'link' };
}

const panel = (title, help, ...body) => h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, title), help ? h('p', { class: 'muted' }, help) : null), ...body);

function toggle(label, checked, set) {
  return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange: (e) => set(e.target.checked) }), label);
}

function numberField(label, value, fallback, set) {
  return h('label', { class: 'field' }, h('span', {}, label), h('input', { type: 'number', min: '0.5', step: '0.5', value: String(value ?? fallback), oninput: (e) => set(Number(e.target.value) || fallback) }));
}

function general(cfg, changed) {
  cfg.attention ||= {};
  const source = h('select', {}, [
    ['auto', 'Checks API, else Actions (automatic)'],
    ['checks', 'Checks API only (classic token)'],
    ['actions', 'Actions API only (fine-grained token)'],
  ].map(([v, t]) => h('option', { value: v }, t)));
  source.value = cfg.checksSource || 'auto';
  source.addEventListener('change', () => ((cfg.checksSource = source.value), changed()));
  return h(
    'section',
    { class: 'panel general' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'General'), h('p', { class: 'muted' }, 'Shared by every repo. The panel refreshes often while a check runs, rarely once everything has settled, and not at all while you are away. Watched PRs (a check you get notified about is running, or you rang their bell) are also checked on their own, every few seconds, so a result reaches you as it lands.')),
    h(
      'div',
      { class: 'fields' },
      numberField('Refresh while checks run (minutes)', cfg.pollMinutes, 2, (v) => ((cfg.pollMinutes = v), changed())),
      numberField('Refresh when all settled (minutes)', cfg.quietPollMinutes, 10, (v) => ((cfg.quietPollMinutes = v), changed())),
      numberField('Check watched PRs every (seconds)', cfg.watchSeconds, 30, (v) => ((cfg.watchSeconds = Math.max(5, v)), changed())),
      h('label', { class: 'field' }, h('span', {}, 'Read checks from'), source),
    ),
    h(
      'div',
      { class: 'switches' },
      toggle('Show all labels, not only watched ones', !!cfg.showOtherLabels, (v) => ((cfg.showOtherLabels = v), changed())),
      toggle('Watch a PR while a check that notifies is running', cfg.autoWatch !== false, (v) => ((cfg.autoWatch = v), changed())),
      ...[['failedChecks', 'a watched check fails'], ['changesRequested', 'changes are requested'], ['conflicts', 'there is a merge conflict']].map(([k, t]) =>
        toggle(`Needs me when ${t}`, !!cfg.attention[k], (v) => ((cfg.attention[k] = v), changed())),
      ),
    ),
  );
}

function sectionPanel(sec, target, changed, rerender) {
  const list = (target[sec.key] ||= []);
  const move = (i, d) => {
    [list[i], list[i + d]] = [list[i + d], list[i]];
    changed();
    rerender();
  };
  const items = list.map((row, i) => {
    const fields = sec.fields.filter((f) => !f.showIf || f.showIf(row));
    return h(
      'div',
      { class: 'item' },
      h(
        'div',
        { class: 'item-body' },
        h('div', { class: 'fields' }, fields.filter((f) => f.type !== 'checkbox').map((f) => control(row, f, changed, rerender))),
        fields.some((f) => f.type === 'checkbox') ? h('div', { class: 'switches' }, fields.filter((f) => f.type === 'checkbox').map((f) => control(row, f, changed, rerender))) : null,
      ),
      h(
        'div',
        { class: 'item-tools' },
        h('button', { class: 'ghost icon sm', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, icon('up', 14)),
        h('button', { class: 'ghost icon sm', title: 'Move down', 'aria-label': 'Move down', disabled: i === list.length - 1, onclick: () => move(i, 1) }, icon('down', 14)),
        h('button', { class: 'ghost icon sm danger', title: 'Remove', 'aria-label': 'Remove', onclick: () => (list.splice(i, 1), changed(), rerender()) }, icon('x', 14)),
      ),
    );
  });
  const add = (item) => {
    if (!item) return;
    list.push(structuredClone(item));
    changed();
    rerender();
  };
  const preset = !sec.presets.length ? null : h('select', { 'aria-label': `Add a preset to ${sec.title}` }, h('option', { value: '' }, 'Add from preset…'), sec.presets.map(([t], i) => h('option', { value: String(i) }, t)));
  preset?.addEventListener('change', () => {
    const p = sec.presets[Number(preset.value)]?.[1];
    add(p === 'site' ? siteExtractor() : p);
  });
  return panel(
    sec.title,
    sec.help,
    h('div', { class: 'items' }, items.length ? items : h('div', { class: 'empty' }, 'None yet.')),
    h('div', { class: 'add-row' }, h('button', { onclick: () => add(sec.blank || Object.fromEntries(sec.fields.map((f) => [f.k, '']))) }, icon('plus', 13), 'Add'), preset),
  );
}

export function renderBuilder(root, cfg, onChange) {
  const rerender = () => renderBuilder(root, cfg, onChange);
  const changed = () => onChange(cfg);
  cfg.repos ||= {};
  if (!cfg.repos[current]) current = Object.keys(cfg.repos)[0] || null;
  const shared = SECTIONS.filter((sec) => sec.shared).map((sec) => sectionPanel(sec, cfg, changed, rerender));
  const perRepo = current
    ? h(
        'div',
        { class: 'repo-scope' },
        SECTIONS.filter((sec) => !sec.shared).map((sec) => sectionPanel(sec, cfg.repos[current], changed, rerender)),
      )
    : null;
  root.replaceChildren(general(cfg, changed), ...shared, repoPicker(cfg, changed, rerender), perRepo || '');
}

// The selected repo, whether the add form is open, and the repos the token
// can see (for the add list).
let current = null;
let adding = false;
let known = [];
let onSelect = () => {};
export function setKnownRepos(repos) {
  known = repos;
}
export function onRepoSelected(fn) {
  onSelect = fn;
}

function repoPicker(cfg, changed, rerender) {
  const repos = Object.keys(cfg.repos);
  const select = (repo) => {
    current = repo;
    rerender();
    onSelect(repo);
  };
  const add = (repo, from) => {
    repo = repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return alert('Enter a repo as owner/name.');
    if (!cfg.repos[repo]) cfg.repos[repo] = structuredClone(from ? cfg.repos[from] : NEW_REPO_PROFILE);
    adding = false;
    changed();
    select(repo);
  };
  const name = h('input', { type: 'text', placeholder: 'owner/name', list: 'dl-repos', 'aria-label': 'Repo to add' });
  const startFrom = h('select', { 'aria-label': 'Start from' }, h('option', { value: '' }, 'Start from the basics'), repos.map((r) => h('option', { value: r }, `Copy ${r}`)));
  const remove = () => {
    if (!confirm(`Stop tracking ${current} and delete its settings?`)) return;
    delete cfg.repos[current];
    current = null;
    changed();
    rerender();
  };
  return panel(
    'Repos you track',
    'Only these repos are tracked. Each has its own labels, checks, reports and buttons; pick one to edit them below.',
    h('datalist', { id: 'dl-repos' }, known.filter((r) => !cfg.repos[r]).map((r) => h('option', { value: r }))),
    h(
      'div',
      { class: 'repo-tabs', role: 'tablist' },
      repos.map((r) => h('button', { class: `repo-tab${r === current ? ' on' : ''}`, role: 'tab', 'aria-selected': String(r === current), onclick: () => select(r) }, r)),
      h('button', { class: 'ghost repo-tab', onclick: () => ((adding = !adding), rerender()) }, icon('plus', 13), 'Add repo'),
    ),
    adding
      ? h('div', { class: 'repo-add' }, name, startFrom, h('button', { class: 'primary', onclick: () => add(name.value, startFrom.value) }, 'Add'), h('button', { class: 'ghost', onclick: () => ((adding = false), rerender()) }, 'Cancel'))
      : null,
    current
      ? h('div', { class: 'repo-scope-head' }, h('span', { class: 'muted' }, 'Editing'), h('span', { class: 'name' }, current), h('span', { class: 'spacer' }), h('button', { class: 'ghost danger sm', onclick: remove }, 'Remove repo'))
      : h('div', { class: 'empty' }, 'No repos yet. Add one to start tracking its PRs.'),
  );
}

export function fillSuggestions(labels, checks) {
  for (const [id, values] of [['dl-labels', labels], ['dl-checks', checks]]) {
    document.getElementById(id).replaceChildren(...values.map((v) => h('option', { value: v })));
  }
}
