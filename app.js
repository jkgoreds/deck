// The page: draws the view, and turns taps into operations.
//
// Everything on screen is derived from the store by model.js on each render.
// Nothing here holds task data of its own, so the screen cannot drift from
// what is saved.

import { DEFAULT_CAPTURE, parseCapture } from './capture-parse.js';
import { demoData } from './demo.js';
import { buildView, clock, dayLabel } from './model.js';
import { newTaskId } from './ops.js';
import { Store } from './store.js';

const root = document.getElementById('app');
const params = new URLSearchParams(location.search);
const isDemo = params.has('demo');

const store = isDemo ? Store.demo(demoData()) : new Store({ storage: safeStorage() });

const ui = {
  tab: 'today',
  open: new Set(), // expanded task rows and mail entries
  folds: new Set(), // which collapsible lists are open: done, later, noise
  sheet: null,
  toast: null,
  toastTimer: null,
  signInError: '',
  signingIn: false,
  authProblem: false,
  shell: false,
  dirty: new Set(),
};

function safeStorage() {
  try {
    localStorage.setItem('deck.probe', '1');
    localStorage.removeItem('deck.probe');
    return localStorage;
  } catch {
    return { getItem: () => null, setItem() {}, removeItem() {} };
  }
}

// ---------- small helpers ----------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

const ICON = {
  check: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.4l2.3 2.3 4.7-5"/></svg>',
  chevron: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3l4 4-4 4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  out: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3H3v8h8V8.5M8 3h3v3M11 3L6.5 7.5"/></svg>',
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>',
  upcoming: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M4 8l8 6 8-6"/></svg>',
};

function localInputValue(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function endOfLocalDay(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(year, month - 1, day, 23, 59).toISOString();
}

function fullDue(row) {
  if (row.dueMs == null) return 'No date';
  const time = row.allDay ? 'end of day' : clock(row.dueMs);
  return `${dayLabel(row.dueMs, Date.now())}, ${time}`;
}

// ---------- pieces of the page ----------

function taskRow(row) {
  const open = ui.open.has(row.id);
  const classes = ['row', row.done && 'done', row.late && !row.done && 'late', row.gone && 'gone', row.priority === 'high' && 'high'].filter(Boolean).join(' ');
  const meta = [
    row.when ? `<span class="when">${esc(row.late && row.daysLate ? `${row.when} · ${plural(row.daysLate, 'day')} late` : row.late ? `${row.when} · late` : row.when)}</span>` : '',
    row.course ? `<span class="chip">${esc(row.course)}</span>` : '',
    row.isNew ? '<span class="badge new">New</span>' : '',
    row.changed ? '<span class="badge moved">Date changed</span>' : '',
    row.gone ? '<span class="badge gone">Removed from Canvas</span>' : '',
  ].join('');
  return `<li class="${classes}" data-id="${esc(row.id)}">
    <button class="check" data-act="toggle-done" data-done="${row.done ? '' : '1'}" aria-label="${row.done ? 'Mark not done' : 'Mark done'}: ${esc(row.title)}"><i>${ICON.check}</i></button>
    <button class="row-main" data-act="toggle-open" aria-expanded="${open}">
      <span class="row-title">${esc(row.title)}</span>
      ${meta ? `<span class="row-meta">${meta}</span>` : ''}
    </button>
    ${open ? taskDetail(row) : ''}
  </li>`;
}

function taskDetail(row) {
  const changed = row.changed && row.changedFromMs != null ? `<p class="note">The due date moved. It was ${esc(dayLabel(row.changedFromMs, Date.now()))}, ${esc(clock(row.changedFromMs))}.</p>` : '';
  const gone = row.gone ? '<p class="note">Canvas no longer lists this. It may have been cancelled or unpublished.</p>' : '';
  const editable = row.own
    ? `<label>Task<input type="text" data-field="title" value="${esc(row.title)}" maxlength="300" /></label>
       <label>Due<input type="datetime-local" data-field="dueAt" value="${esc(localInputValue(row.dueMs))}" /></label>`
    : `<p class="note">Due ${esc(fullDue(row))}${row.course ? ` · ${esc(row.course)}` : ''}</p>`;
  return `<div class="detail">
    ${changed}${gone}${editable}
    <label>Notes<textarea data-field="notes" placeholder="Anything you want to remember about this">${esc(row.notes)}</textarea></label>
    <div class="actions">
      ${row.url ? `<a class="btn" href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">Open in Canvas ${ICON.out}</a>` : ''}
      ${row.own && row.dueMs != null ? '<button class="btn" data-act="clear-date">Remove date</button>' : ''}
      ${row.own ? '<button class="btn danger" data-act="delete">Delete</button>' : '<button class="btn" data-act="hide">Hide this</button>'}
    </div>
  </div>`;
}

function block(title, body, { count = null, tone = '' } = {}) {
  return `<section class="block ${tone}"><h2>${esc(title)}${count != null ? ` <span class="n">${count}</span>` : ''}</h2>${body}</section>`;
}

const card = (items) => `<ul class="card">${items.join('')}</ul>`;

function fold(key, label, body) {
  const open = ui.folds.has(key);
  return `<section class="block"><button class="fold" data-act="toggle-fold" data-key="${key}" aria-expanded="${open}">${ICON.chevron}${esc(label)}</button>${open ? body : ''}</section>`;
}

function renderToday(view) {
  if (view.empty) {
    return `<section class="block"><div class="card welcome"><b>Waiting for the first update</b>
      <p>Deck is connected, but the scheduled run has not written anything yet. It runs each morning; you can also start one by hand from the repository's Actions tab.</p></div></section>`;
  }
  const parts = [];
  if (view.classes.length) {
    parts.push(block('Classes', card(view.classes.map((c) => `<li class="class-row ${c.state}"><span class="time">${esc(c.start)}</span><span class="name">${esc(c.course)}${c.state === 'now' ? ' · now' : ''}<span class="where">until ${esc(c.end)} · ${esc(c.room)}</span></span></li>`))));
  }
  if (view.overdue.length) parts.push(block('Overdue', card(view.overdue.map(taskRow)), { count: view.overdue.length, tone: 'overdue' }));
  parts.push(block('Due today', view.today.length ? card(view.today.map(taskRow)) : '<div class="card"><p class="empty-line">Nothing due today.</p></div>', { count: view.today.length || null }));
  if (view.undated.length) parts.push(block('No date', card(view.undated.map(taskRow)), { count: view.undated.length }));
  return parts.join('');
}

function renderUpcoming(view) {
  const parts = [];
  if (view.upcoming.length) {
    parts.push(`<section class="block"><h2>Next two weeks <span class="n">${view.counts.upcoming}</span></h2>${view.upcoming.map((day) => `<h3 class="day-head">${esc(day.label)}</h3>${card(day.rows.map(taskRow))}`).join('')}</section>`);
  } else {
    parts.push(block('Next two weeks', '<div class="card"><p class="empty-line">Nothing coming up in the next two weeks.</p></div>'));
  }
  if (view.later.length) parts.push(fold('later', `Later (${view.later.length})`, card(view.later.map(taskRow))));
  if (view.done.length) parts.push(fold('done', `Completed recently (${view.done.length})`, card(view.done.map(taskRow))));
  return parts.join('');
}

const ACCOUNT_LABEL = { teams: 'Teams', canvas: 'Canvas' };
const accountChip = (m) => {
  const label = ACCOUNT_LABEL[m.origin] || (m.account === 'school' ? 'School' : m.account === 'personal' ? 'Personal' : '');
  // "Teams · Teams" says nothing twice; the label is only shown when it adds something.
  return label && label !== m.from ? `<span class="chip">${label}</span>` : '';
};

function mailWhy(m) {
  const sorter = m.by === 'claude' ? 'Claude read this' : m.by === 'you' ? 'Your choice' : 'Sorted by rule';
  return `<div class="mail-why">
    <span>${esc(sorter)}${m.reason ? `: ${esc(m.reason.charAt(0).toLowerCase() + m.reason.slice(1))}` : ''}.</span>
    <div class="actions">
      <button class="btn" data-act="sender-important" data-addr="${esc(m.fromAddr)}">Always show ${esc(m.from)}</button>
      <button class="btn" data-act="sender-mute" data-addr="${esc(m.fromAddr)}">Mute ${esc(m.from)}</button>
    </div>
  </div>`;
}

function mailCard(m) {
  const open = ui.open.has(m.id);
  return `<li class="mail" data-id="${esc(m.id)}">
    <div class="mail-head"><span class="from">${esc(m.from)}</span>${accountChip(m)}<span class="age">${esc(m.age)}</span></div>
    <p class="mail-subject">${esc(m.subject)}</p>
    ${m.summary ? `<p class="mail-summary">${esc(m.summary)}</p>` : ''}
    <div class="actions">
      <button class="btn primary" data-act="mail-task">Add as task</button>
      <button class="btn" data-act="mail-dismiss">Done</button>
      ${m.link ? `<a class="btn" href="${esc(m.link)}" target="_blank" rel="noopener noreferrer">Open ${ICON.out}</a>` : ''}
      <button class="btn quiet" data-act="toggle-open" aria-expanded="${open}">Why?</button>
    </div>
    ${open ? mailWhy(m) : ''}
  </li>`;
}

function fyiRow(m) {
  const open = ui.open.has(m.id);
  return `<li data-id="${esc(m.id)}">
    <button class="fyi" data-act="toggle-open" aria-expanded="${open}">
      <span class="line"><b>${esc(m.from)}</b> — ${esc(m.summary || m.subject)}</span>
      <span class="sub">${esc(m.age)}${m.summary ? ` · ${esc(m.subject)}` : ''}</span>
    </button>
    ${open ? `<div class="fyi-open"><div class="actions">
        <button class="btn" data-act="mail-dismiss">Clear</button>
        <button class="btn" data-act="mail-task">Add as task</button>
        ${m.link ? `<a class="btn" href="${esc(m.link)}" target="_blank" rel="noopener noreferrer">Open ${ICON.out}</a>` : ''}
      </div>${mailWhy(m)}</div>` : ''}
  </li>`;
}

function noiseRow(m) {
  return `<li class="noise-row" data-id="${esc(m.id)}"><span class="line"><b>${esc(m.from)}</b> — ${esc(m.subject)}</span><button class="btn" data-act="mail-rescue" data-addr="${esc(m.fromAddr)}">Not noise</button></li>`;
}

function renderMail(view) {
  const { action, fyi, noise } = view.mail;
  const parts = [];
  parts.push(block('Needs you', action.length ? card(action.map(mailCard)) : '<div class="card"><p class="empty-line">No email is waiting on you.</p></div>', { count: action.length || null, tone: 'needs' }));
  if (fyi.length) parts.push(block('Good to know', card(fyi.map(fyiRow)), { count: fyi.length }));
  if (noise.length) parts.push(fold('noise', `Filtered out (${noise.length})`, card(noise.map(noiseRow))));
  return parts.join('');
}

function renderStatus(view) {
  if (store.sync === 'saving') return '<span class="dot busy"></span>Saving…';
  if (store.sync === 'offline') return '<span class="dot warn"></span>Offline';
  if (store.sync === 'error') return '<span class="dot bad"></span>Not saved';
  return `<span class="dot ${view.health.level}"></span>${esc(view.health.label)}`;
}

function renderBanner(view) {
  if (ui.authProblem) return `<button class="banner bad" data-act="sign-out"><span>${esc(store.error || 'The access key stopped working.')} Your unsaved changes are kept on this device.</span><b>Sign in again</b></button>`;
  if (store.sync === 'offline') return `<div class="banner"><span>You're offline. Changes are kept here and will save when the connection returns.</span></div>`;
  if (store.sync === 'error') return `<button class="banner bad" data-act="refresh"><span>${esc(store.error || 'A change could not be saved.')}</span><b>Try again</b></button>`;
  const worst = view.health.sources.find((s) => s.level === 'bad') || view.health.sources.find((s) => s.level === 'warn');
  if (!worst) return '';
  return `<button class="banner ${worst.level === 'bad' ? 'bad' : ''}" data-act="open-sources"><span><strong>${esc(worst.name)}:</strong> ${esc(worst.detail)}</span><b>Details</b></button>`;
}

function renderSources(view) {
  const rules = view.senders.length
    ? view.senders.map((s) => `<div class="rule-row"><span>${esc(s.key)} — ${s.rule === 'noise' ? 'muted' : 'always shown'}</span><button class="btn" data-act="sender-clear" data-key="${esc(s.key)}">Remove</button></div>`).join('')
    : '<p class="fine">None yet. Use “Mute” or “Always show” on any email to teach the filter.</p>';
  return `<div class="sheet-wrap" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true" aria-label="Sources and settings">
    <div class="sheet-head"><h2>Where this comes from</h2><button class="btn" data-act="close-sheet">Close</button></div>
    <h3>Sources</h3>
    ${view.health.sources.map((s) => `<div class="source"><span class="dot ${s.level}"></span><b>${esc(s.name)}</b><p>${esc(s.detail)}</p></div>`).join('')}
    <h3>Your sender rules</h3>
    ${rules}
    <h3>This device</h3>
    <div class="actions"><button class="btn" data-act="refresh">Check for updates now</button>${isDemo ? '' : '<button class="btn danger" data-act="sign-out">Sign out</button>'}</div>
    <p class="fine">${isDemo ? 'Demo mode: sample data, nothing is saved.' : `Reading from ${esc(store.auth.repo)}. Updates arrive from the scheduled run several times a day.`}</p>
  </div></div>`;
}

function renderSignIn() {
  return `<form class="signin" id="signin">
    <img src="icon.svg" alt="" />
    <h1>Deck</h1>
    <p>Everything due and everything that needs you, in one place. Connect this device to your private data once; it stays signed in.</p>
    <label>Repository<input name="repo" placeholder="your-name/deck-data" autocomplete="off" autocapitalize="none" spellcheck="false" required /></label>
    <label>Access key<input name="token" type="password" placeholder="github_pat_…" autocomplete="off" required /></label>
    ${ui.signInError ? `<p class="error" role="alert">${esc(ui.signInError)}</p>` : ''}
    <button class="btn primary" type="submit" ${ui.signingIn ? 'disabled' : ''}>${ui.signingIn ? 'Connecting…' : 'Connect'}</button>
    <p class="fine">The key is stored only in this browser and is sent only to GitHub. <a href="?demo">See a demo with sample data</a></p>
  </form>`;
}

function shellHtml() {
  return `<header class="topbar">
      <div class="title"><h1 id="date"></h1><p id="headline"></p></div>
      <form class="add" id="add-form" autocomplete="off">
        <div class="add-row"><div class="add-field">
          <label class="sr" for="add-input">Add a task</label>
          <input id="add-input" placeholder="Add a task — try “econ essay fri 5pm”" enterkeyhint="done" maxlength="300" />
          <div class="add-preview" id="add-preview" aria-live="polite"></div>
        </div><button type="button" class="add-cancel" data-act="cancel-add">Cancel</button></div>
      </form>
      <button class="status" id="status" data-act="open-sources" aria-label="Sources and settings"></button>
    </header>
    <div id="banner"></div>
    <div class="scrim" data-act="cancel-add"></div>
    <main class="columns">
      <div class="col" id="col-today" data-tab="today"></div>
      <div class="col" id="col-upcoming" data-tab="upcoming"></div>
      <div class="col" id="col-mail" data-tab="mail"></div>
    </main>
    <nav class="tabbar" aria-label="Sections">
      <button class="tab" data-act="tab" data-tab="today"><span class="icon">${ICON.today}<span class="pip" id="pip-today" hidden></span></span>Today</button>
      <button class="tab" data-act="tab" data-tab="upcoming"><span class="icon">${ICON.upcoming}<span class="pip calm" id="pip-upcoming" hidden></span></span>Upcoming</button>
      <button class="tab" data-act="tab" data-tab="mail"><span class="icon">${ICON.mail}<span class="pip" id="pip-mail" hidden></span></span>Mail</button>
    </nav>
    <button class="fab" data-act="start-add" aria-label="Add a task">${ICON.plus}</button>
    <div id="sheet"></div>
    <div id="toast"></div>`;
}

// ---------- drawing ----------

let view = null;

function render() {
  if (!store.signedIn) {
    ui.shell = false;
    document.body.classList.remove('adding');
    root.innerHTML = renderSignIn();
    return;
  }
  if (!ui.shell) {
    root.innerHTML = shellHtml();
    ui.shell = true;
  }
  view = buildView(store.site, store.user, Date.now(), store.seenBefore);
  const focused = focusKey();

  document.title = view.counts.today || view.counts.mail ? `(${view.counts.today + view.counts.mail}) Deck` : 'Deck';
  byId('date').textContent = view.dateLabel;
  byId('headline').textContent = store.loaded ? view.headline : 'Loading…';
  byId('status').innerHTML = renderStatus(view);
  byId('banner').innerHTML = renderBanner(view);

  paint('col-today', renderToday(view));
  paint('col-upcoming', renderUpcoming(view));
  paint('col-mail', renderMail(view));

  for (const column of root.querySelectorAll('.col')) column.classList.toggle('active', column.dataset.tab === ui.tab);
  for (const tab of root.querySelectorAll('.tab')) {
    if (tab.dataset.tab === ui.tab) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  pip('pip-today', view.counts.today);
  pip('pip-upcoming', view.counts.fresh);
  pip('pip-mail', view.counts.mail);

  byId('sheet').innerHTML = ui.sheet === 'sources' ? renderSources(view) : '';
  restoreFocus(focused);
  byId('toast').innerHTML = ui.toast ? `<div class="toast" role="status"><span>${esc(ui.toast.text)}</span>${ui.toast.undo ? '<button data-act="undo">Undo</button>' : ''}</div>` : '';
}

const byId = (id) => document.getElementById(id);

// Redrawing a column replaces its buttons; remember which one had focus so keyboard use is not interrupted.
function focusKey() {
  const el = document.activeElement;
  if (!el || !el.dataset?.act || !el.closest('.col')) return null;
  return { act: el.dataset.act, id: el.closest('[data-id]')?.dataset.id || null, key: el.dataset.key || null };
}

function restoreFocus(saved) {
  if (!saved || (document.activeElement && document.activeElement !== document.body)) return;
  for (const el of root.querySelectorAll(`.col [data-act="${saved.act}"]`)) {
    if ((el.closest('[data-id]')?.dataset.id || null) === saved.id && (el.dataset.key || null) === saved.key) {
      el.focus({ preventScroll: true });
      return;
    }
  }
}

// A column is not redrawn while the user is typing inside it; it is redrawn when they leave the field.
function paint(id, html) {
  const node = byId(id);
  const active = document.activeElement;
  if (active && node.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName)) {
    ui.dirty.add(id);
    return;
  }
  ui.dirty.delete(id);
  if (node.innerHTML !== html) node.innerHTML = html;
}

function pip(id, count) {
  const node = byId(id);
  node.hidden = !count;
  node.textContent = count > 99 ? '99+' : String(count || '');
}

function toast(text, undo = null) {
  clearTimeout(ui.toastTimer);
  ui.toast = { text, undo };
  ui.toastTimer = setTimeout(() => {
    ui.toast = null;
    render();
  }, undo ? 7000 : 3500);
}

// ---------- actions ----------

function findRow(id) {
  if (!view) return null;
  const lists = [view.today, view.overdue, view.undated, view.later, view.done, ...view.upcoming.map((day) => day.rows)];
  for (const list of lists) {
    const row = list.find((candidate) => candidate.id === id);
    if (row) return row;
  }
  return null;
}

const findMail = (id) => (view ? [...view.mail.action, ...view.mail.fyi, ...view.mail.noise].find((m) => m.id === id) : null);

const ACTIONS = {
  tab: ({ el }) => {
    ui.tab = el.dataset.tab;
    window.scrollTo({ top: 0 });
  },
  'toggle-open': ({ id }) => (ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id)),
  'toggle-fold': ({ el }) => (ui.folds.has(el.dataset.key) ? ui.folds.delete(el.dataset.key) : ui.folds.add(el.dataset.key)),
  'open-sources': () => (ui.sheet = 'sources'),
  'close-sheet': ({ el, event }) => {
    // The backdrop closes the sheet; a click inside the sheet does not.
    if (el.classList.contains('sheet-wrap') && event.target !== el) return false;
    ui.sheet = null;
  },
  'start-add': () => {
    document.body.classList.add('adding');
    byId('add-input').focus();
    return false;
  },
  'cancel-add': () => {
    closeAdd();
    return false;
  },
  refresh: () => {
    ui.authProblem = false;
    store.refresh().then(() => store.flush());
    toast('Checking for updates…');
  },
  'sign-out': () => {
    if (!ui.authProblem && store.pending.length && !confirm('Some changes have not been saved yet. Sign out anyway?')) return false;
    ui.authProblem = false;
    ui.sheet = null;
    store.signOut();
  },
  undo: () => {
    const undo = ui.toast?.undo;
    ui.toast = null;
    if (undo) store.commit(...undo);
  },
  'toggle-done': ({ id, el }) => {
    const done = el.dataset.done === '1';
    const row = findRow(id);
    store.commit({ t: 'done', id, done, at: new Date().toISOString() });
    if (done) toast(`Done: ${row ? row.title : 'task'}`, [{ t: 'done', id, done: false }]);
  },
  hide: ({ id }) => {
    ui.open.delete(id);
    store.commit({ t: 'hide', id, hidden: true });
    toast('Hidden', [{ t: 'hide', id, hidden: false }]);
  },
  delete: ({ id }) => {
    const task = store.user.tasks.find((candidate) => candidate.id === id);
    ui.open.delete(id);
    store.commit({ t: 'delete', id });
    toast('Deleted', task ? [{ t: 'add', task }] : null);
  },
  'clear-date': ({ id }) => store.commit({ t: 'edit', id, patch: { dueAt: null, allDay: false } }),
  'mail-task': ({ id }) => {
    const m = findMail(id);
    if (!m) return;
    const task = {
      id: newTaskId(),
      title: (m.task || m.subject).slice(0, 300),
      dueAt: m.due ? endOfLocalDay(m.due) : null,
      allDay: !!m.due,
      notes: `From ${m.from}: ${m.subject}`,
      fromMail: m.id,
      createdAt: new Date().toISOString(),
    };
    store.commit({ t: 'add', task }, { t: 'mail', id, mark: 'tasked' });
    toast(`Added: ${task.title}`, [{ t: 'delete', id: task.id }, { t: 'mail', id, mark: null }]);
  },
  'mail-dismiss': ({ id }) => {
    ui.open.delete(id);
    store.commit({ t: 'mail', id, mark: 'dismissed' });
    toast('Cleared', [{ t: 'mail', id, mark: null }]);
  },
  'mail-rescue': ({ id }) => {
    store.commit({ t: 'mail', id, mark: 'rescued' });
    toast('Moved to Good to know', [{ t: 'mail', id, mark: null }]);
  },
  'sender-important': ({ el }) => {
    const key = el.dataset.addr;
    if (!key) return;
    store.commit({ t: 'sender', key, rule: 'important' });
    toast(`${key} will always be shown`, [{ t: 'sender', key, rule: null }]);
  },
  'sender-mute': ({ id, el }) => {
    const key = el.dataset.addr;
    if (!key) return;
    ui.open.delete(id);
    store.commit({ t: 'sender', key, rule: 'noise' }, { t: 'mail', id, mark: 'dismissed' });
    toast(`${key} muted`, [{ t: 'sender', key, rule: null }, { t: 'mail', id, mark: null }]);
  },
  'sender-clear': ({ el }) => store.commit({ t: 'sender', key: el.dataset.key, rule: null }),
};

root.addEventListener('click', (event) => {
  const el = event.target.closest('[data-act]');
  if (!el || !root.contains(el)) return;
  const action = ACTIONS[el.dataset.act];
  if (!action) return;
  if (el.tagName !== 'A') event.preventDefault();
  const id = el.closest('[data-id]')?.dataset.id || null;
  if (action({ el, id, event }) !== false) render();
});

// Edits inside an expanded task save when the field is left.
root.addEventListener('focusout', (event) => {
  const field = event.target.dataset?.field;
  const id = event.target.closest?.('[data-id]')?.dataset.id;
  if (field && id) {
    const row = findRow(id);
    const value = event.target.value;
    if (field === 'notes' && row && value !== row.notes) store.commit({ t: 'edit', id, patch: { notes: value } });
    if (field === 'title' && row && value.trim() && value.trim() !== row.title) store.commit({ t: 'edit', id, patch: { title: value.trim() } });
  }
  // Give focus a moment to land elsewhere, then redraw any column that was held back.
  if (ui.dirty.size) setTimeout(() => ui.dirty.size && render(), 0);
});

root.addEventListener('change', (event) => {
  if (event.target.dataset?.field !== 'dueAt') return;
  const id = event.target.closest('[data-id]')?.dataset.id;
  const value = event.target.value;
  if (id) store.commit({ t: 'edit', id, patch: { dueAt: value ? new Date(value).toISOString() : null, allDay: false } });
});

// ---------- quick add ----------

const KIND_LABEL = { priority: 'Priority', project: 'Class', effort: 'Effort' };

function describeCapture(parsed) {
  if (!parsed.ok || !parsed.title) return '';
  const chips = [`<span>Adds “<b>${esc(parsed.title)}</b>”</span>`];
  if (parsed.fields.dueAt) {
    const due = Date.parse(parsed.fields.dueAt);
    const dateOnly = parsed.consumed.some((token) => token.kind === 'date');
    chips.push(`<span class="chip">${esc(dayLabel(due, Date.now()))}${dateOnly ? '' : `, ${esc(clock(due))}`}</span>`);
  }
  for (const token of parsed.consumed) {
    if (KIND_LABEL[token.kind] && token.kind !== 'effort') chips.push(`<span class="chip">${KIND_LABEL[token.kind]}: ${esc(token.value)}</span>`);
  }
  return chips.join('');
}

function closeAdd() {
  document.body.classList.remove('adding');
  const input = byId('add-input');
  if (input) {
    input.value = '';
    input.blur();
  }
  const preview = byId('add-preview');
  if (preview) preview.innerHTML = '';
}

root.addEventListener('input', (event) => {
  if (event.target.id !== 'add-input') return;
  byId('add-preview').innerHTML = describeCapture(parseCapture(event.target.value, DEFAULT_CAPTURE, Date.now()));
});

root.addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.target.id === 'signin') return signIn(new FormData(event.target));
  if (event.target.id !== 'add-form') return;
  const parsed = parseCapture(byId('add-input').value, DEFAULT_CAPTURE, Date.now());
  if (!parsed.ok || !parsed.title) return;
  const task = {
    id: newTaskId(),
    title: parsed.title,
    dueAt: parsed.fields.dueAt,
    allDay: parsed.consumed.some((token) => token.kind === 'date'),
    priority: parsed.fields.priority || 'normal',
    course: parsed.fields.project ? parsed.fields.project.toUpperCase() : '',
    createdAt: new Date().toISOString(),
  };
  store.commit({ t: 'add', task });
  closeAdd();
  toast(`Added: ${task.title}`, [{ t: 'delete', id: task.id }]);
  render();
});

async function signIn(form) {
  ui.signingIn = true;
  ui.signInError = '';
  render();
  try {
    await store.signIn(form.get('repo'), form.get('token'));
  } catch (error) {
    ui.signInError = error.message || 'Could not connect.';
  }
  ui.signingIn = false;
  render();
}

// ---------- keyboard ----------

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  if (event.key === 'Escape') {
    if (ui.sheet) {
      ui.sheet = null;
      render();
    } else if (document.activeElement?.id === 'add-input') {
      closeAdd();
    } else if (typing) {
      document.activeElement.blur();
    }
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey || !store.signedIn) return;
  if (event.key === '/' || event.key === 'n') {
    event.preventDefault();
    if (matchMedia('(max-width: 899px)').matches) document.body.classList.add('adding');
    byId('add-input')?.focus();
  }
});

// ---------- keeping current ----------

let lastRefresh = 0;
function refreshIfStale(maxAgeMs) {
  if (Date.now() - lastRefresh < maxAgeMs) return;
  lastRefresh = Date.now();
  store.refresh();
}

store.subscribe((what) => {
  if (what === 'auth-problem') ui.authProblem = true;
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshIfStale(60_000);
  else store.flush();
});
window.addEventListener('online', () => store.refresh().then(() => store.flush()));
setInterval(() => document.visibilityState === 'visible' && refreshIfStale(5 * 60_000), 60_000);
// Time-based labels ("now", "late", "5 min ago") move on even when no data changes.
setInterval(() => document.visibilityState === 'visible' && store.signedIn && render(), 60_000);

// A setup link can carry the repository and key after the #, which browsers never send to a server.
async function signInFromLink() {
  if (!location.hash.includes('key=')) return;
  const link = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  if (store.signedIn || !link.get('repo') || !link.get('key')) return;
  const form = new FormData();
  form.set('repo', link.get('repo'));
  form.set('token', link.get('key'));
  await signIn(form);
}

store.markVisit(Date.now());
render();
if (!isDemo) {
  signInFromLink().then(() => {
    if (store.signedIn) refreshIfStale(0);
  });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
