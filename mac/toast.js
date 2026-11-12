// Builds the cards from what background.js notifies with: a title of
// "owner/repo#N PR title" and one changed thing per message line.
import { readNotice } from './ext/lib.js';

const MAX = 4;
const LIFE_MS = 8000;
const FAIL_LIFE_MS = 15000;

const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text ? { textContent: text } : {});

function fit() {
  requestAnimationFrame(() => window.cards.resize(document.querySelector('.card') ? Math.ceil(document.body.scrollHeight) : 0));
}

function dismiss(card) {
  if (card.classList.contains('leaving')) return;
  card.classList.add('leaving');
  // Only the card's own exit: the timer's animationend bubbles up here too.
  card.addEventListener('animationend', (e) => e.animationName === 'leave' && (card.remove(), fit()));
}

function show({ id, title, message }) {
  const { pr, title: prTitle, lines, tone } = readNotice({ title, message });

  const card = el('div', `card ${tone}`);
  card.dataset.id = id;
  card.style.setProperty('--life', `${tone === 'fail' ? FAIL_LIFE_MS : LIFE_MS}ms`);
  const icon = el('img', 'icon');
  icon.src = 'ext/icon.png';
  icon.alt = '';
  const body = el('div', 'body');
  const meta = el('div', 'meta');
  meta.append(el('span', 'app', 'PR Radar'));
  if (pr) meta.append(el('span', '', '·'), el('span', 'pr', `${pr.name}#${pr.number}`));
  meta.append(el('span', '', '·'), el('span', '', 'now'));
  const list = el('ul');
  for (const line of lines) {
    const li = el('li');
    li.append(el('span', `dot ${line.tone}`), el('span', '', line.text));
    list.append(li);
  }
  body.append(meta, el('div', 'title', prTitle), list);
  const close = el('button', 'close', '×');
  close.title = 'Dismiss';
  close.addEventListener('click', (e) => (e.stopPropagation(), dismiss(card)));
  const timer = el('div', 'timer');
  timer.addEventListener('animationend', () => dismiss(card));
  card.append(icon, body, close, timer);
  card.addEventListener('click', () => (window.cards.click(id), dismiss(card)));

  document.body.prepend(card);
  [...document.querySelectorAll('.card:not(.leaving)')].slice(MAX).forEach(dismiss);
  fit();
}

window.cards.onShow(show);
window.cards.onClear((id) => document.querySelectorAll('.card').forEach((c) => c.dataset.id === id && dismiss(c)));
