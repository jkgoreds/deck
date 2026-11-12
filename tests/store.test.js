import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, ConflictError, GitHubFiles, MissingError, OfflineError, Store, decodeBase64, encodeBase64, parseRepo } from '../store.js';
import { emptyUser } from '../ops.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), data };
}

// Timers that only fire when the test says so.
function manualTimers() {
  const queue = [];
  return {
    setTimeout: (fn, delay) => (queue.push({ fn, delay }), queue.length),
    clearTimeout: (id) => { if (id) queue[id - 1] = null; },
    async runAll() { while (queue.some(Boolean)) { const i = queue.findIndex(Boolean); const { fn } = queue[i]; queue[i] = null; await fn(); } },
    get lastDelay() { return [...queue].reverse().find(Boolean)?.delay; },
  };
}

// An in-memory stand-in for the repository's two files.
function fakeFiles(start = {}) {
  const repo = { site: start.site ?? { generatedAt: 'T', items: [{ id: 'canvas:1' }], mail: [], noise: [] }, user: start.user ?? emptyUser(), sha: start.user ? 'sha1' : null, writes: [], failWrites: [], siteReads: 0 };
  const files = {
    repo,
    async check() {},
    async readSite(etag) { repo.siteReads += 1; if (repo.site === null) throw new MissingError(); return etag === 'e1' ? { unchanged: true } : { site: repo.site, etag: 'e1' }; },
    async readUser() { return { user: structuredClone(repo.user), sha: repo.sha }; },
    async writeUser(user, sha) {
      const failure = repo.failWrites.shift();
      if (failure) throw failure;
      if (sha !== repo.sha) throw new ConflictError();
      repo.user = structuredClone(user);
      repo.sha = `sha${repo.writes.length + 2}`;
      repo.writes.push(structuredClone(user));
      return repo.sha;
    },
  };
  return files;
}

function signedInStore(files, storage = memoryStorage({ 'deck.auth': JSON.stringify({ repo: 'me/deck-data', token: 't' }) })) {
  const timers = manualTimers();
  const store = new Store({ storage, timers, filesFactory: () => files });
  return { store, timers, storage };
}

const done = (id) => ({ t: 'done', id, done: true, at: 'T' });

test('base64 round-trips non-ASCII text', () => {
  const text = 'Café — “quotes” 日本語 ✓';
  assert.equal(decodeBase64(encodeBase64(text)), text);
});

test('repository names are accepted in the forms people paste', () => {
  assert.equal(parseRepo('me/deck-data'), 'me/deck-data');
  assert.equal(parseRepo(' https://github.com/me/deck-data.git '), 'me/deck-data');
  assert.equal(parseRepo('https://github.com/me/deck-data/'), 'me/deck-data');
  assert.equal(parseRepo('just-a-name'), null);
  assert.equal(parseRepo('a/b/c'), null);
});

test('refresh loads both files and caches them', async () => {
  const { store, storage } = signedInStore(fakeFiles({ user: { ...emptyUser(), mail: { 'mail:1': 'dismissed' } } }));
  await store.refresh();
  assert.equal(store.site.generatedAt, 'T');
  assert.deepEqual(store.user.mail, { 'mail:1': 'dismissed' });
  assert.equal(JSON.parse(storage.getItem('deck.cache')).etag, 'e1');
});

test('a second visit paints from the cache before any network call', async () => {
  const files = fakeFiles();
  const first = signedInStore(files);
  await first.store.refresh();
  const second = new Store({ storage: first.storage, timers: manualTimers(), filesFactory: () => files });
  assert.equal(second.loaded, true);
  assert.equal(second.site.generatedAt, 'T');
});

test('an unchanged bundle is not downloaded again', async () => {
  const files = fakeFiles();
  const { store } = signedInStore(files);
  await store.refresh();
  files.repo.site = { generatedAt: 'SHOULD-NOT-BE-READ' };
  await store.refresh(); // etag matches, so the fake reports "unchanged"
  assert.equal(store.site.generatedAt, 'T');
});

test('before the first run there is no bundle, and that is not an error', async () => {
  const { store } = signedInStore(fakeFiles({ site: null }));
  store.files.repo.site = null;
  await store.refresh();
  assert.equal(store.site, null);
  assert.equal(store.sync, 'idle');
  assert.equal(store.loaded, true);
});

test('a change shows immediately and is saved after a short pause', async () => {
  const files = fakeFiles();
  const { store, timers } = signedInStore(files);
  await store.refresh();
  store.commit(done('canvas:1'));
  assert.equal(store.user.state['canvas:1'].done, true);
  assert.equal(store.sync, 'saving');
  assert.equal(files.repo.writes.length, 0);
  await timers.runAll();
  assert.equal(files.repo.writes.length, 1);
  assert.equal(files.repo.user.state['canvas:1'].done, true);
  assert.deepEqual([store.sync, store.pending.length], ['idle', 0]);
});

test('several quick taps become one save', async () => {
  const files = fakeFiles();
  const { store, timers } = signedInStore(files);
  await store.refresh();
  store.commit(done('canvas:1'));
  store.commit({ t: 'mail', id: 'mail:9', mark: 'dismissed' });
  store.commit({ t: 'add', task: { id: 'm:1', title: 'x' } });
  await timers.runAll();
  assert.equal(files.repo.writes.length, 1);
  assert.equal(files.repo.user.tasks.length, 1);
});

test('when another device saved first, its change and ours both survive', async () => {
  const files = fakeFiles();
  const { store, timers } = signedInStore(files);
  await store.refresh();
  // The laptop saves while the phone still holds the old version.
  files.repo.user = { ...emptyUser(), tasks: [{ id: 'm:laptop', title: 'From laptop', done: false }] };
  files.repo.sha = 'sha-laptop';
  store.commit(done('canvas:1'));
  await timers.runAll();
  assert.equal(files.repo.user.tasks[0].id, 'm:laptop');
  assert.equal(files.repo.user.state['canvas:1'].done, true);
  assert.equal(store.sync, 'idle');
});

test('offline changes survive closing the tab', async () => {
  const files = fakeFiles();
  const { store, timers, storage } = signedInStore(files);
  await store.refresh();
  files.repo.failWrites.push(new OfflineError(), new OfflineError(), new OfflineError(), new OfflineError());
  store.commit(done('canvas:1'));
  // First save attempt fails; the store goes offline and schedules a retry.
  await store.flush();
  assert.equal(store.sync, 'offline');
  assert.equal(JSON.parse(storage.getItem('deck.pending')).length, 1);
  assert.equal(timers.lastDelay, 5000);

  // A fresh page load picks the queued change back up and saves it.
  files.repo.failWrites.length = 0;
  const reopened = new Store({ storage, timers: manualTimers(), filesFactory: () => files });
  assert.equal(reopened.user.state['canvas:1'].done, true);
  await reopened.refresh();
  await reopened.flush();
  assert.equal(files.repo.user.state['canvas:1'].done, true);
  assert.equal(reopened.pending.length, 0);
});

test('a tap during a save is not lost', async () => {
  const files = fakeFiles();
  const { store, timers } = signedInStore(files);
  await store.refresh();
  const original = files.writeUser;
  files.writeUser = async (user, sha) => {
    files.writeUser = original;
    store.pending.push({ t: 'add', task: { id: 'm:late', title: 'Added mid-save' } }); // arrives mid-save
    return original(user, sha);
  };
  store.commit(done('canvas:1'));
  await timers.runAll();
  assert.equal(files.repo.user.tasks[0].id, 'm:late');
  assert.equal(files.repo.user.state['canvas:1'].done, true);
  assert.equal(files.repo.writes.length, 2);
});

test('an expired key is surfaced as an auth problem, and the change is kept', async () => {
  const files = fakeFiles();
  const { store } = signedInStore(files);
  await store.refresh();
  const events = [];
  store.subscribe((what) => events.push(what));
  files.repo.failWrites.push(new AuthError('expired'));
  store.commit(done('canvas:1'));
  await store.flush();
  assert.ok(events.includes('auth-problem'));
  assert.equal(store.pending.length, 1);
});

test('signing in validates the key and remembers it; signing out forgets everything', async () => {
  const files = fakeFiles();
  const storage = memoryStorage();
  const store = new Store({ storage, timers: manualTimers(), filesFactory: () => files });
  assert.equal(store.signedIn, false);
  await assert.rejects(() => store.signIn('nonsense', 'k'), /does not look like a repository/);
  await store.signIn('https://github.com/me/deck-data', ' key ');
  assert.deepEqual(JSON.parse(storage.getItem('deck.auth')), { repo: 'me/deck-data', token: 'key' });
  assert.equal(store.site.generatedAt, 'T');
  store.signOut();
  assert.equal(storage.data.size, 0);
  assert.equal(store.signedIn, false);
});

test('a wrong repository name gives an explanation, not a stack trace', async () => {
  const files = fakeFiles();
  files.check = async () => { throw new MissingError(); };
  const store = new Store({ storage: memoryStorage(), timers: manualTimers(), filesFactory: () => files });
  await assert.rejects(() => store.signIn('me/typo', 'k'), /cannot find that repository/);
  assert.equal(store.signedIn, false);
});

test('"new since last visit" survives a reload but resets on the next real visit', () => {
  const storage = memoryStorage();
  const open = (now) => { const s = new Store({ storage, timers: manualTimers(), filesFactory: () => fakeFiles() }); s.markVisit(now); return s.seenBefore; };
  const HOUR = 3_600_000;
  assert.equal(open(1000 * HOUR), null);             // first ever visit: nothing can be new
  assert.equal(open(1000 * HOUR + 60_000), null);    // reload a minute later: same visit
  assert.equal(open(1010 * HOUR), 1000 * HOUR);      // next morning: new means "since last visit began"
  assert.equal(open(1010 * HOUR + 60_000), 1000 * HOUR); // reload: badges stay
});

test('demo mode never touches storage or the network', () => {
  const store = Store.demo({ site: { generatedAt: 'T', items: [] }, user: emptyUser() });
  store.commit({ t: 'add', task: { id: 'm:1', title: 'x' } });
  assert.equal(store.user.tasks.length, 1);
  assert.equal(store.sync, 'idle');
});

test('GitHubFiles: sends the key, bypasses the HTTP cache, and maps statuses to errors', async () => {
  const calls = [];
  const respond = (status, body = {}, headers = {}) => ({ status, json: async () => body, headers: { get: (name) => headers[name] ?? null } });
  let next = respond(200, { generatedAt: 'T' }, { ETag: 'W/"abc"' });
  const files = new GitHubFiles('me/deck-data', 'secret', async (url, init) => { calls.push({ url, init }); if (next instanceof Error) throw next; return next; });

  assert.deepEqual(await files.readSite('old'), { site: { generatedAt: 'T' }, etag: 'W/"abc"' });
  assert.equal(calls[0].url, 'https://api.github.com/repos/me/deck-data/contents/data/site.json');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].init.headers['If-None-Match'], 'old');
  assert.equal(calls[0].init.cache, 'no-store');

  next = respond(304);
  assert.deepEqual(await files.readSite('e'), { unchanged: true });
  next = respond(404);
  assert.deepEqual(await files.readUser(), { user: emptyUser(), sha: null });
  next = respond(200, { content: encodeBase64(JSON.stringify({ tasks: [{ id: 'm:1', title: 'é' }] })), sha: 's' });
  assert.equal((await files.readUser()).user.tasks[0].title, 'é');
  next = respond(200, { content: { sha: 'new' } });
  assert.equal(await files.writeUser(emptyUser(), 's'), 'new');
  assert.equal(JSON.parse(calls.at(-1).init.body).sha, 's');
  assert.equal(calls.at(-1).init.method, 'PUT');

  for (const [status, type] of [[401, AuthError], [403, AuthError], [409, ConflictError], [422, ConflictError], [502, OfflineError]]) {
    next = respond(status);
    await assert.rejects(() => files.writeUser(emptyUser(), 's'), type);
  }
  next = new TypeError('Failed to fetch');
  await assert.rejects(() => files.readSite(), OfflineError);
});
