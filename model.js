// Turns the two data files into exactly what the screen shows.
//
// Pure: no clock, no DOM, no storage. Everything time-dependent comes in
// through `nowMs`, so every rule here can be tested for any moment.

import { normalizeUser } from './ops.js';

const DAY = 86_400_000;
const DAY_CODES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const UPCOMING_DAYS = 14;
const DONE_WINDOW_DAYS = 14;
const OVERDUE_WINDOW_DAYS = 21;
const NEW_WINDOW_DAYS = 7;
const STALE_HOURS = 26; // the runner goes at least twice a morning; a day without one is a real gap

const ms = (iso) => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

export function startOfDay(nowMs) {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Whole local calendar days between two instants (DST-safe: compares dates, not elapsed hours).
export function dayDiff(fromMs, toMs) {
  const a = new Date(fromMs);
  const b = new Date(toMs);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY);
}

export function clock(valueMs) {
  return new Date(valueMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function clock24(value) {
  const [hour, minute] = value.split(':').map(Number);
  return clock(new Date(2000, 0, 1, hour, minute).getTime());
}

export function dayLabel(dayMs, nowMs) {
  const delta = dayDiff(nowMs, dayMs);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  if (delta === -1) return 'Yesterday';
  const d = new Date(dayMs);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return delta > 1 && delta < 7 ? `${weekday} · ${date}` : `${d.toLocaleDateString('en-US', { weekday: 'short' })}, ${date}`;
}

export function ago(thenMs, nowMs) {
  if (thenMs == null) return 'never';
  const minutes = Math.max(0, Math.floor((nowMs - thenMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24 && dayDiff(thenMs, nowMs) === 0) return `at ${clock(thenMs)}`;
  const days = dayDiff(thenMs, nowMs);
  if (days <= 1) return `yesterday at ${clock(thenMs)}`;
  return `${days} days ago`;
}

function whenLabel(dueMs, allDay) {
  const d = new Date(dueMs);
  if (allDay || (d.getHours() === 23 && d.getMinutes() === 59)) return 'End of day';
  return clock(dueMs);
}

// One row per piece of work, whichever file it came from.
function rows(site, user, nowMs, seenBeforeMs) {
  const out = [];
  for (const item of site.items || []) {
    const mark = user.state[item.id] || {};
    if (mark.hidden) continue;
    const firstSeen = ms(item.firstSeen);
    out.push({
      id: item.id,
      own: false,
      source: 'canvas',
      kind: item.kind || 'assignment',
      title: item.title,
      course: item.course || '',
      dueMs: ms(item.dueAt),
      allDay: !!item.allDay,
      url: typeof item.url === 'string' && item.url.startsWith('https://') ? item.url : '',
      notes: mark.notes || '',
      done: !!mark.done,
      doneMs: ms(mark.doneAt),
      gone: !!item.gone,
      changed: !!item.changed,
      changedFromMs: item.changed ? ms(item.changed.from) : null,
      history: !!item.pastOnArrival,
      isNew: seenBeforeMs != null && firstSeen != null && firstSeen > seenBeforeMs && nowMs - firstSeen < NEW_WINDOW_DAYS * DAY,
      priority: 'normal',
    });
  }
  // A task carried over from the old app steps aside once Canvas lists the same thing itself.
  const canvasTitles = new Set((site.items || []).map((item) => titleKey(item.title)));
  for (const task of user.tasks) {
    if (task.imported && canvasTitles.has(titleKey(task.title))) continue;
    out.push({
      id: task.id,
      own: true,
      source: 'own',
      kind: 'task',
      title: task.title,
      course: task.course || '',
      dueMs: ms(task.dueAt),
      allDay: !!task.allDay,
      url: '',
      notes: task.notes || '',
      done: !!task.done,
      doneMs: ms(task.doneAt),
      gone: false,
      changed: false,
      changedFromMs: null,
      history: false,
      isNew: false,
      priority: task.priority || 'normal',
      fromMail: task.fromMail || null,
    });
  }
  return out;
}

export const titleKey = (title) => String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const byDue = (a, b) => (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity) || a.title.localeCompare(b.title);

function classesToday(site, nowMs) {
  const now = new Date(nowMs);
  const code = DAY_CODES[now.getDay()];
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = (value) => value.split(':').map(Number).reduce((h, m) => h * 60 + m);
  return (site.schedule?.classes || [])
    .filter((c) => (c.days || []).includes(code))
    .map((c) => ({
      course: c.course,
      room: c.room || '',
      start: clock24(c.start),
      end: clock24(c.end),
      startMinutes: toMinutes(c.start),
      state: minutes >= toMinutes(c.end) ? 'past' : minutes >= toMinutes(c.start) ? 'now' : 'ahead',
    }))
    .sort((a, b) => a.startMinutes - b.startMinutes);
}

function mailView(site, user, nowMs) {
  const handled = user.mail;
  const decorate = (entry) => ({
    ...entry,
    link: typeof entry.link === 'string' && entry.link.startsWith('https://mail.google.com/') ? entry.link : '',
    dateMs: ms(entry.date),
    age: ago(ms(entry.date), nowMs),
    senderRule: user.senders[(entry.fromAddr || '').toLowerCase()] || null,
  });
  const live = (site.mail || []).filter((entry) => !handled[entry.id] || handled[entry.id] === 'rescued');
  // A message the user just rescued shows up at once, without waiting for the next run to reclassify it.
  const rescued = (site.noise || []).filter((entry) => handled[entry.id] === 'rescued').map((entry) => ({ ...entry, bucket: 'fyi', summary: '', account: '', origin: 'mail', by: 'you', reason: 'You pulled this out of the filtered pile' }));
  return {
    action: live.filter((entry) => entry.bucket === 'action').map(decorate),
    fyi: [...live.filter((entry) => entry.bucket === 'fyi'), ...rescued].map(decorate).sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0)),
    noise: (site.noise || []).filter((entry) => handled[entry.id] !== 'rescued').map(decorate),
  };
}

const SOURCE_NAMES = { canvas: 'Canvas', gmail: 'Gmail', school: 'School email', teams: 'Teams' };

export function health(site, nowMs) {
  const status = site.status || {};
  const sources = [];
  let level = 'ok';
  const raise = (to) => {
    if (to === 'bad' || (to === 'warn' && level === 'ok')) level = to;
  };

  for (const name of ['canvas', 'gmail']) {
    const source = status.sources?.[name] || { state: 'off' };
    const last = ms(source.lastSuccess);
    if (source.state === 'off') {
      sources.push({ name: SOURCE_NAMES[name], level: 'off', detail: 'Not connected yet' });
    } else if (source.state === 'failing') {
      raise('bad');
      sources.push({ name: SOURCE_NAMES[name], level: 'bad', detail: `${source.error || 'Could not be read'}. Last good update ${ago(last, nowMs)}.` });
    } else if (last == null || nowMs - last > STALE_HOURS * 3_600_000) {
      raise('warn');
      sources.push({ name: SOURCE_NAMES[name], level: 'warn', detail: `No update since ${ago(last, nowMs)} — the scheduled run may have stopped.` });
    } else {
      sources.push({ name: SOURCE_NAMES[name], level: 'ok', detail: `Updated ${ago(last, nowMs)}${source.count != null ? ` · ${source.count} ${name === 'canvas' ? 'items' : 'recent messages'}` : ''}` });
    }
  }

  const gmailOn = status.sources?.gmail?.state && status.sources.gmail.state !== 'off';
  if (gmailOn) {
    const school = status.sources?.school || {};
    const lastSchool = ms(school.lastMail);
    if (school.state === 'quiet') {
      raise('warn');
      sources.push({ name: SOURCE_NAMES.school, level: 'warn', detail: `Nothing forwarded since ${ago(lastSchool, nowMs)}. Check that Outlook is still forwarding to Gmail.` });
    } else if (lastSchool == null) {
      sources.push({ name: SOURCE_NAMES.school, level: 'off', detail: 'No forwarded school email seen yet' });
    } else {
      sources.push({ name: SOURCE_NAMES.school, level: 'ok', detail: `Last message ${ago(lastSchool, nowMs)}` });
    }
    const lastTeams = ms(status.sources?.teams?.lastMail);
    sources.push(lastTeams == null ? { name: SOURCE_NAMES.teams, level: 'off', detail: 'No Teams notification seen yet' } : { name: SOURCE_NAMES.teams, level: 'ok', detail: `Last notification ${ago(lastTeams, nowMs)}` });
  }

  const ai = status.ai || {};
  const filter = ai.mode && ai.mode !== 'off' ? (ai.ok === false ? { level: 'warn', detail: 'Claude was unreachable on the last run, so mail was sorted by rules only.' } : { level: 'ok', detail: 'Mail is read by Claude, with rules as the backstop' }) : { level: 'off', detail: 'Mail is sorted by rules only (Claude is not connected)' };
  if (filter.level === 'warn') raise('warn');
  sources.push({ name: 'Mail filter', ...filter });

  const lastRun = ms(status.lastRun || site.generatedAt);
  const label = level === 'bad' ? 'A source is failing' : level === 'warn' ? 'Needs a look' : lastRun == null ? 'Waiting for first update' : `Updated ${ago(lastRun, nowMs)}`;
  return { level: lastRun == null && level === 'ok' ? 'off' : level, label, sources, lastRunMs: lastRun };
}

function count(n, one, many) {
  return `${n} ${n === 1 ? one : many || `${one}s`}`;
}

export function headline(view) {
  const parts = [];
  const left = view.classes.filter((c) => c.state !== 'past').length;
  if (view.classes.length) parts.push(left === view.classes.length ? count(left, 'class', 'classes') : left ? `${count(left, 'class', 'classes')} left` : 'classes done');
  if (view.today.length) parts.push(`${count(view.today.length, 'thing')} due today`);
  if (view.overdue.length) parts.push(`${view.overdue.length} overdue`);
  if (view.mail.action.length) parts.push(`${count(view.mail.action.length, 'email')} that need${view.mail.action.length === 1 ? 's' : ''} you`);
  if (!parts.length) return 'Nothing scheduled and nothing waiting on you.';
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

export function buildView(siteInput, userInput, nowMs, seenBeforeMs = null) {
  const site = siteInput && typeof siteInput === 'object' ? siteInput : {};
  const user = normalizeUser(userInput);
  const dayStart = startOfDay(nowMs);
  const all = rows(site, user, nowMs, seenBeforeMs);

  const today = [];
  const overdue = [];
  const undated = [];
  const later = [];
  const days = new Map();
  const done = [];

  for (const row of all) {
    if (row.done) {
      if (row.doneMs != null && nowMs - row.doneMs < DONE_WINDOW_DAYS * DAY) done.push(row);
      continue;
    }
    if (row.dueMs == null) {
      if (!row.gone) undated.push(row);
      continue;
    }
    const delta = dayDiff(nowMs, row.dueMs);
    const decorated = { ...row, when: whenLabel(row.dueMs, row.allDay), late: row.dueMs < nowMs && !row.gone };
    if (delta === 0) {
      today.push(decorated);
    } else if (delta < 0) {
      // Something that was already over when Deck first saw it is history, not a missed deadline.
      if (!row.history && !row.gone && -delta <= OVERDUE_WINDOW_DAYS) overdue.push({ ...decorated, when: dayLabel(row.dueMs, nowMs), daysLate: -delta });
    } else if (delta <= UPCOMING_DAYS) {
      const key = startOfDay(row.dueMs);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(decorated);
    } else {
      later.push({ ...decorated, when: dayLabel(row.dueMs, nowMs) });
    }
  }

  const view = {
    dateLabel: new Date(nowMs).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    classes: classesToday(site, nowMs),
    today: today.sort(byDue),
    overdue: overdue.sort(byDue),
    upcoming: [...days.entries()].sort((a, b) => a[0] - b[0]).map(([key, list]) => ({ key, label: dayLabel(key, nowMs), rows: list.sort(byDue) })),
    later: later.sort(byDue),
    undated: undated.sort((a, b) => a.title.localeCompare(b.title)),
    done: done.sort((a, b) => (b.doneMs || 0) - (a.doneMs || 0)),
    mail: mailView(site, user, nowMs),
    senders: Object.entries(user.senders).map(([key, rule]) => ({ key, rule })).sort((a, b) => a.key.localeCompare(b.key)),
    health: health(site, nowMs),
    empty: !site.generatedAt && user.tasks.length === 0,
  };
  view.headline = headline(view);
  view.counts = {
    today: view.today.length + view.overdue.length,
    upcoming: view.upcoming.reduce((sum, day) => sum + day.rows.length, 0),
    mail: view.mail.action.length,
    fresh: all.filter((row) => row.isNew && !row.done).length,
  };
  return view;
}
