import test from 'node:test';
import assert from 'node:assert/strict';
import { ago, buildView, dayDiff, dayLabel, headline, health } from '../model.js';
import { emptyUser } from '../ops.js';

// Built from local-time parts so the suite passes in any timezone.
const at = (day, hour = 12, minute = 0) => new Date(2026, 10, day, hour, minute).getTime(); // November 2026
const iso = (day, hour, minute) => new Date(at(day, hour, minute)).toISOString();
const NOW = at(12, 14, 0); // Thursday 12 Nov, 2:00 pm

const item = (id, title, dueAt, over = {}) => ({ id: `canvas:${id}`, source: 'canvas', kind: 'assignment', title, course: 'LAW 210', dueAt, allDay: false, url: 'https://canvas.instructure.com/x', firstSeen: iso(10, 9), pastOnArrival: false, ...over });

const site = (over = {}) => ({
  generatedAt: iso(12, 6, 40),
  items: [
    item('today', 'Quiz 9', iso(12, 17)),
    item('morning', 'Reading check', iso(12, 9)),
    item('tonight', 'Case Analysis', iso(12, 23, 59)),
    item('tomorrow', 'Chapter 12', iso(13, 23, 59)),
    item('nextweek', 'Problem Set', iso(17, 12), { course: 'ECON 202' }),
    item('far', 'Final Paper', new Date(2026, 11, 15, 12).toISOString()),
    item('late', 'Lab Report 3', iso(9, 23, 59)),
    item('history', 'Old Homework', iso(1, 23, 59), { pastOnArrival: true }),
    item('undated', 'Read syllabus', null),
  ],
  mail: [
    { id: 'mail:1', bucket: 'action', from: 'Dr. Lee', fromAddr: 'alee@college.example', subject: 'Exam moved', summary: 'Confirm.', date: iso(12, 8), link: 'https://mail.google.com/mail/?authuser=x#all/ff' },
    { id: 'mail:2', bucket: 'fyi', from: 'Friend', fromAddr: 'f@gmail.com', subject: 'photos', summary: 'Photos.', date: iso(12, 7), link: 'javascript:alert(1)' },
  ],
  noise: [{ id: 'mail:3', from: 'Shop', fromAddr: 'deals@shop.com', subject: '50% off', date: iso(12, 5) }],
  schedule: { classes: [
    { course: 'MATH 140', days: ['Tu', 'Th'], start: '09:00', end: '10:15', room: '204 North' },
    { course: 'ECON 202', days: ['Tu', 'Th'], start: '13:30', end: '14:45', room: '12 Science' },
    { course: 'NIGHT 1', days: ['Th'], start: '18:00', end: '19:00', room: 'X' },
    { course: 'HIST 105', days: ['Mo', 'We', 'Fr'], start: '11:00', end: '11:50', room: '5 West Hall' },
  ] },
  status: { lastRun: iso(12, 6, 40), sources: { canvas: { state: 'ok', lastSuccess: iso(12, 6, 40), count: 9 }, gmail: { state: 'ok', lastSuccess: iso(12, 6, 40), count: 3 }, school: { state: 'ok', lastMail: iso(12, 8) }, teams: {} }, ai: { mode: 'cli', ok: true } },
  ...over,
});

const ids = (rows) => rows.map((row) => row.id.replace('canvas:', ''));

test('work is sorted into today, overdue, upcoming days, later and undated', () => {
  const view = buildView(site(), emptyUser(), NOW);
  assert.deepEqual(ids(view.today), ['morning', 'today', 'tonight']);
  assert.deepEqual(ids(view.overdue), ['late']);
  assert.deepEqual(view.upcoming.map((day) => [day.label, ids(day.rows)]), [['Tomorrow', ['tomorrow']], ['Tuesday · Nov 17', ['nextweek']]]);
  assert.deepEqual(ids(view.later), ['far']);
  assert.deepEqual(ids(view.undated), ['undated']);
});

test('assignments that were already over on arrival are never shown as overdue', () => {
  const view = buildView(site(), emptyUser(), NOW);
  assert.ok(!ids(view.overdue).includes('history'));
});

test('time labels: clock time, end of day, and late-today flag', () => {
  const view = buildView(site(), emptyUser(), NOW);
  const row = Object.fromEntries(view.today.map((r) => [r.id.replace('canvas:', ''), r]));
  assert.deepEqual([row.today.when, row.tonight.when, row.morning.when], ['5:00 PM', 'End of day', '9:00 AM']);
  assert.deepEqual([row.morning.late, row.today.late], [true, false]);
  assert.equal(view.overdue[0].daysLate, 3);
});

test('done and hidden items leave the lists; recent completions are kept for undo', () => {
  const user = { ...emptyUser(), state: { 'canvas:today': { done: true, doneAt: iso(12, 13) }, 'canvas:tonight': { hidden: true } } };
  const view = buildView(site(), user, NOW);
  assert.deepEqual(ids(view.today), ['morning']);
  assert.deepEqual(ids(view.done), ['today']);
});

test('own tasks are merged in with everything else', () => {
  const user = { ...emptyUser(), tasks: [{ id: 'm:1', title: 'Call advisor', dueAt: iso(12, 15), done: false }, { id: 'm:2', title: 'Buy poster board', dueAt: null, done: false }] };
  const view = buildView(site(), user, NOW);
  assert.deepEqual(ids(view.today), ['morning', 'm:1', 'today', 'tonight']);
  assert.ok(view.today.find((r) => r.id === 'm:1').own);
  assert.deepEqual(ids(view.undated), ['m:2', 'undated']);
});

test('a task imported from the old app steps aside when Canvas lists the same thing', () => {
  const tasks = [
    { id: 'm:a', title: 'quiz 9!', dueAt: iso(12, 17), done: false, imported: true },   // Canvas has "Quiz 9"
    { id: 'm:b', title: 'Quiz 9', dueAt: iso(12, 17), done: false },                    // typed by hand: always kept
    { id: 'm:c', title: 'Exam 3 at the testing center', dueAt: iso(19, 9), done: false, imported: true }, // not in Canvas
  ];
  const view = buildView(site(), { ...emptyUser(), tasks }, NOW);
  const shown = [...view.today, ...view.later, ...view.upcoming.flatMap((d) => d.rows)].filter((r) => r.own).map((r) => r.id);
  assert.deepEqual(shown.sort(), ['m:b', 'm:c']);
});

test('new means first seen since the last visit — and nothing is new on a first visit', () => {
  const fresh = site();
  fresh.items[3].firstSeen = iso(12, 6, 40);
  assert.equal(buildView(fresh, emptyUser(), NOW, null).counts.fresh, 0);
  const view = buildView(fresh, emptyUser(), NOW, at(11, 20));
  assert.equal(view.counts.fresh, 1);
  assert.ok(view.upcoming[0].rows[0].isNew);
});

test('a withdrawn item is shown as gone, not as overdue or late', () => {
  const withdrawn = site();
  withdrawn.items[0].gone = true;
  withdrawn.items[6].gone = true;
  const view = buildView(withdrawn, emptyUser(), NOW);
  assert.ok(view.today.find((r) => r.id === 'canvas:today').gone);
  assert.deepEqual(view.overdue, []);
});

test('classes for the weekday, with past / now / ahead', () => {
  const view = buildView(site(), emptyUser(), NOW);
  assert.deepEqual(view.classes.map((c) => [c.course, c.state, c.start]), [['MATH 140', 'past', '9:00 AM'], ['ECON 202', 'now', '1:30 PM'], ['NIGHT 1', 'ahead', '6:00 PM']]);
});

test('mail: handled messages disappear, unsafe links are dropped', () => {
  const view = buildView(site(), { ...emptyUser(), mail: { 'mail:1': 'dismissed' } }, NOW);
  assert.deepEqual(view.mail.action, []);
  assert.equal(view.mail.fyi[0].link, '');
  const open = buildView(site(), emptyUser(), NOW);
  assert.equal(open.mail.action[0].link, 'https://mail.google.com/mail/?authuser=x#all/ff');
});

test('a rescued message moves from the filtered pile to good-to-know immediately', () => {
  const view = buildView(site(), { ...emptyUser(), mail: { 'mail:3': 'rescued' } }, NOW);
  assert.deepEqual(view.mail.noise, []);
  assert.ok(view.mail.fyi.some((m) => m.id === 'mail:3'));
});

test('headline counts what is left of the day', () => {
  const view = buildView(site(), emptyUser(), NOW);
  assert.equal(view.headline, '2 classes left, 3 things due today, 1 overdue and 1 email that needs you.');
  assert.equal(headline({ classes: [], today: [], overdue: [], mail: { action: [] } }), 'Nothing scheduled and nothing waiting on you.');
});

test('health: all good', () => {
  const h = health(site(), NOW);
  assert.equal(h.level, 'ok');
  assert.match(h.label, /^Updated at 6:40 AM$/);
  assert.deepEqual(h.sources.map((s) => [s.name, s.level]), [['Canvas', 'ok'], ['Gmail', 'ok'], ['School email', 'ok'], ['Teams', 'off'], ['Mail filter', 'ok']]);
});

test('health: a failing source is loud and says when it last worked', () => {
  const broken = site();
  broken.status.sources.canvas = { state: 'failing', error: 'Canvas feed could not be read', lastSuccess: iso(11, 6, 40) };
  const h = health(broken, NOW);
  assert.equal(h.level, 'bad');
  assert.match(h.sources[0].detail, /could not be read\. Last good update yesterday at 6:40 AM\./);
});

test('health: a run that silently stopped is caught by age alone', () => {
  const stale = site();
  for (const name of ['canvas', 'gmail']) stale.status.sources[name].lastSuccess = iso(9, 6, 40);
  assert.equal(health(stale, NOW).level, 'warn');
});

test('health: quiet school mail and unreachable Claude are warnings', () => {
  const quiet = site();
  quiet.status.sources.school = { state: 'quiet', lastMail: iso(5, 9) };
  assert.equal(health(quiet, NOW).level, 'warn');
  const noAi = site();
  noAi.status.ai = { mode: 'cli', ok: false };
  assert.equal(health(noAi, NOW).level, 'warn');
});

test('nothing set up yet is reported as waiting, not as healthy', () => {
  const view = buildView({}, emptyUser(), NOW);
  assert.equal(view.empty, true);
  assert.equal(view.health.level, 'off');
  assert.equal(view.health.label, 'Waiting for first update');
});

test('date helpers', () => {
  assert.equal(dayDiff(at(12, 23, 59), at(13, 0, 1)), 1);
  assert.equal(dayLabel(at(13), NOW), 'Tomorrow');
  assert.equal(dayLabel(at(11), NOW), 'Yesterday');
  assert.equal(dayLabel(at(25), NOW), 'Wed, Nov 25');
  assert.equal(ago(NOW - 30_000, NOW), 'just now');
  assert.equal(ago(NOW - 5 * 60_000, NOW), '5 min ago');
  assert.equal(ago(at(9, 8), NOW), '3 days ago');
  assert.equal(ago(null, NOW), 'never');
});
