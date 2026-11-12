import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, applyOps, emptyUser, newTaskId, normalizeUser, prune } from '../ops.js';

const task = (over = {}) => ({ id: 'm:abc', title: 'Call advisor', createdAt: '2026-11-12T12:00:00Z', ...over });

test('adding a task fills in defaults and is idempotent', () => {
  const once = applyOp(emptyUser(), { t: 'add', task: task() });
  const twice = applyOp(once, { t: 'add', task: task() });
  assert.equal(twice.tasks.length, 1);
  assert.deepEqual(twice.tasks[0], { done: false, doneAt: null, notes: '', course: '', priority: 'normal', dueAt: null, allDay: false, ...task() });
});

test('a task with no title, or an id that is not a task id, is refused', () => {
  assert.equal(applyOp(emptyUser(), { t: 'add', task: task({ title: '  ' }) }).tasks.length, 0);
  assert.equal(applyOp(emptyUser(), { t: 'add', task: task({ id: 'canvas:1' }) }).tasks.length, 0);
});

test('done on an own task flips the task; on a Canvas item it records state', () => {
  let user = applyOp(emptyUser(), { t: 'add', task: task() });
  user = applyOps(user, [{ t: 'done', id: 'm:abc', done: true, at: 'T1' }, { t: 'done', id: 'canvas:9', done: true, at: 'T2' }]);
  assert.deepEqual([user.tasks[0].done, user.tasks[0].doneAt], [true, 'T1']);
  assert.deepEqual(user.state['canvas:9'], { done: true, doneAt: 'T2' });
  user = applyOp(user, { t: 'done', id: 'canvas:9', done: false });
  assert.deepEqual(user.state['canvas:9'], { done: false, doneAt: null });
});

test('replaying the same operations gives the same document', () => {
  const ops = [{ t: 'add', task: task() }, { t: 'done', id: 'm:abc', done: true, at: 'T' }, { t: 'mail', id: 'mail:1', mark: 'dismissed' }, { t: 'sender', key: 'A@B.com', rule: 'noise' }];
  assert.deepEqual(applyOps(applyOps(emptyUser(), ops), ops), applyOps(emptyUser(), ops));
});

test('edits to own tasks take known fields only; Canvas items accept a note and nothing else', () => {
  let user = applyOp(emptyUser(), { t: 'add', task: task() });
  user = applyOp(user, { t: 'edit', id: 'm:abc', patch: { title: 'New', dueAt: '2026-11-13T22:00:00Z', id: 'm:evil', done: true } });
  assert.deepEqual([user.tasks[0].id, user.tasks[0].title, user.tasks[0].done], ['m:abc', 'New', false]);
  user = applyOp(user, { t: 'edit', id: 'canvas:1', patch: { title: 'hijack' } });
  assert.equal(user.state['canvas:1'], undefined);
  user = applyOp(user, { t: 'edit', id: 'canvas:1', patch: { notes: 'bring calculator' } });
  assert.deepEqual(user.state['canvas:1'], { notes: 'bring calculator' });
});

test('hide keeps other state, and cannot be applied to an own task', () => {
  let user = applyOps(emptyUser(), [{ t: 'edit', id: 'canvas:1', patch: { notes: 'n' } }, { t: 'hide', id: 'canvas:1', hidden: true }]);
  assert.deepEqual(user.state['canvas:1'], { notes: 'n', hidden: true });
  assert.deepEqual(applyOp(emptyUser(), { t: 'hide', id: 'm:abc', hidden: true }).state, {});
});

test('delete removes own tasks only', () => {
  let user = applyOps(emptyUser(), [{ t: 'add', task: task() }, { t: 'done', id: 'canvas:1', done: true }]);
  user = applyOps(user, [{ t: 'delete', id: 'canvas:1' }, { t: 'delete', id: 'm:abc' }]);
  assert.equal(user.tasks.length, 0);
  assert.ok(user.state['canvas:1']);
});

test('mail marks and sender rules can be set and cleared', () => {
  let user = applyOps(emptyUser(), [{ t: 'mail', id: 'mail:1', mark: 'tasked' }, { t: 'sender', key: '@Shop.com', rule: 'noise' }]);
  assert.deepEqual([user.mail, user.senders], [{ 'mail:1': 'tasked' }, { '@shop.com': 'noise' }]);
  user = applyOps(user, [{ t: 'mail', id: 'mail:1', mark: null }, { t: 'sender', key: '@shop.com', rule: null }, { t: 'mail', id: 'mail:2', mark: 'nonsense' }]);
  assert.deepEqual([user.mail, user.senders], [{}, {}]);
});

test('prototype-polluting keys are refused', () => {
  const user = applyOps(emptyUser(), [{ t: 'done', id: '__proto__', done: true }, { t: 'mail', id: 'constructor', mark: 'dismissed' }, { t: 'sender', key: '__proto__', rule: 'noise' }]);
  assert.deepEqual([user.state, user.mail, user.senders], [{}, {}, {}]);
  assert.equal({}.done, undefined);
});

test('unknown operations and malformed documents are tolerated', () => {
  assert.deepEqual(applyOp(null, { t: 'explode' }), emptyUser());
  assert.deepEqual(normalizeUser({ tasks: 'x', state: [], mail: null }), emptyUser());
});

test('prune drops bookkeeping for things that no longer exist, and nothing else', () => {
  const user = { ...emptyUser(), tasks: [task()], state: { 'canvas:live': { done: true }, 'canvas:old': { done: true } }, mail: { 'mail:live': 'dismissed', 'mail:old': 'dismissed', 'mail:noise': 'rescued' }, senders: { 'a@b.com': 'noise' } };
  const site = { items: [{ id: 'canvas:live' }], mail: [{ id: 'mail:live' }], noise: [{ id: 'mail:noise' }] };
  const pruned = prune(user, site);
  assert.deepEqual(Object.keys(pruned.state), ['canvas:live']);
  assert.deepEqual(Object.keys(pruned.mail).sort(), ['mail:live', 'mail:noise']);
  assert.equal(pruned.tasks.length, 1);
  assert.deepEqual(pruned.senders, { 'a@b.com': 'noise' });
});

test('prune does nothing when the bundle is missing or empty', () => {
  const user = { ...emptyUser(), state: { 'canvas:1': { done: true } } };
  assert.deepEqual(prune(user, null).state, user.state);
  assert.deepEqual(prune(user, { items: [], mail: [], noise: [] }).state, user.state);
});

test('task ids are unique-looking and recognisable', () => {
  const a = newTaskId(1000, () => 0.1);
  const b = newTaskId(1000, () => 0.9);
  assert.match(a, /^m:[a-z0-9]+$/);
  assert.notEqual(a, b);
});
