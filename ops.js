// Every change the user can make, as a small replayable operation.
//
// The site never edits the user document directly. It records operations,
// applies them locally at once so the screen responds immediately, and
// replays them on top of whatever the server holds when it saves. Each one
// is idempotent, so replaying after a conflict (the phone and the laptop
// saving at the same moment) can never double-apply or lose a change.

export function emptyUser() {
  return { version: 1, tasks: [], state: {}, mail: {}, senders: {} };
}

export function normalizeUser(raw) {
  const user = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    tasks: Array.isArray(user.tasks) ? user.tasks : [],
    state: isPlain(user.state) ? user.state : {},
    mail: isPlain(user.mail) ? user.mail : {},
    senders: isPlain(user.senders) ? user.senders : {},
  };
}

function isPlain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isOwnTask = (id) => typeof id === 'string' && id.startsWith('m:');

// Keys that would reach a shared prototype if used as a property name.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const safeKey = (key) => typeof key === 'string' && key.length > 0 && key.length < 300 && !UNSAFE_KEYS.has(key);

const TASK_FIELDS = ['title', 'dueAt', 'allDay', 'notes', 'course', 'priority'];

export function applyOp(input, op) {
  const user = normalizeUser(input);
  if (!op || typeof op !== 'object') return user;

  switch (op.t) {
    case 'done': {
      if (!safeKey(op.id)) return user;
      if (isOwnTask(op.id)) {
        return { ...user, tasks: user.tasks.map((task) => (task.id === op.id ? { ...task, done: !!op.done, doneAt: op.done ? op.at : null } : task)) };
      }
      return { ...user, state: { ...user.state, [op.id]: { ...user.state[op.id], done: !!op.done, doneAt: op.done ? op.at : null } } };
    }
    case 'hide': {
      if (!safeKey(op.id) || isOwnTask(op.id)) return user;
      return { ...user, state: { ...user.state, [op.id]: { ...user.state[op.id], hidden: !!op.hidden } } };
    }
    case 'add': {
      const task = op.task;
      if (!task || !isOwnTask(task.id) || typeof task.title !== 'string' || !task.title.trim()) return user;
      if (user.tasks.some((existing) => existing.id === task.id)) return user;
      return { ...user, tasks: [...user.tasks, { done: false, doneAt: null, notes: '', course: '', priority: 'normal', dueAt: null, allDay: false, ...task }] };
    }
    case 'edit': {
      if (!safeKey(op.id) || !isPlain(op.patch)) return user;
      if (isOwnTask(op.id)) {
        const patch = Object.fromEntries(TASK_FIELDS.filter((field) => field in op.patch).map((field) => [field, op.patch[field]]));
        return { ...user, tasks: user.tasks.map((task) => (task.id === op.id ? { ...task, ...patch } : task)) };
      }
      // A Canvas item belongs to Canvas; the only thing the user can attach to it is a note.
      if (!('notes' in op.patch)) return user;
      return { ...user, state: { ...user.state, [op.id]: { ...user.state[op.id], notes: String(op.patch.notes) } } };
    }
    case 'delete': {
      if (!isOwnTask(op.id)) return user;
      return { ...user, tasks: user.tasks.filter((task) => task.id !== op.id) };
    }
    case 'mail': {
      if (!safeKey(op.id)) return user;
      const mail = { ...user.mail };
      if (op.mark === 'dismissed' || op.mark === 'tasked' || op.mark === 'rescued') mail[op.id] = op.mark;
      else delete mail[op.id];
      return { ...user, mail };
    }
    case 'sender': {
      if (!safeKey(op.key)) return user;
      const senders = { ...user.senders };
      if (op.rule === 'important' || op.rule === 'noise') senders[op.key.toLowerCase()] = op.rule;
      else delete senders[op.key.toLowerCase()];
      return { ...user, senders };
    }
    default:
      return user;
  }
}

export function applyOps(user, ops) {
  return ops.reduce(applyOp, normalizeUser(user));
}

// Old bookkeeping has no use once the thing it described is gone: marks for
// mail that has aged out of the bundle, and done/hidden flags for Canvas
// items the feed no longer carries. Pruned at save time so the file stays small.
export function prune(input, site) {
  const user = normalizeUser(input);
  if (!site) return user;
  const liveItems = new Set((site.items || []).map((item) => item.id));
  const liveMail = new Set([...(site.mail || []), ...(site.noise || [])].map((entry) => entry.id));
  if (liveItems.size === 0 && liveMail.size === 0) return user; // an empty bundle is not evidence of anything
  return {
    ...user,
    state: Object.fromEntries(Object.entries(user.state).filter(([id]) => liveItems.has(id))),
    mail: Object.fromEntries(Object.entries(user.mail).filter(([id]) => liveMail.has(id))),
  };
}

export function newTaskId(nowMs = Date.now(), random = Math.random) {
  return `m:${nowMs.toString(36)}${Math.floor(random() * 1679616).toString(36).padStart(4, '0')}`;
}
