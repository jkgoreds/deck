// Where the data lives and how changes get saved.
//
// The data sits in a private GitHub repository. The runner owns
// data/site.json; this page owns data/user.json. The page keeps a local copy
// so it opens instantly, applies every change on screen at once, and saves in
// the background — queued changes survive a closed tab or a dead connection
// and are replayed when the next save succeeds.

import { applyOps, emptyUser, normalizeUser, prune } from './ops.js';

const API = 'https://api.github.com';
const KEY = { auth: 'deck.auth', cache: 'deck.cache', pending: 'deck.pending', seen: 'deck.seen' };
const SAVE_DELAY = 700;
const RETRY_DELAYS = [5_000, 15_000, 60_000];
const VISIT_GAP = 3_600_000;

export class AuthError extends Error {}
export class ConflictError extends Error {}
export class MissingError extends Error {}
export class OfflineError extends Error {}

export function encodeBase64(text) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(encoded) {
  return new TextDecoder().decode(Uint8Array.from(atob(encoded.replace(/\s/g, '')), (char) => char.charCodeAt(0)));
}

export function parseRepo(value) {
  const match = /^\s*(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s*$/.exec(value || '');
  return match ? `${match[1]}/${match[2]}` : null;
}

// The two files, and nothing else, over GitHub's contents API.
export class GitHubFiles {
  constructor(repo, token, fetchImpl = (...args) => globalThis.fetch(...args)) {
    this.repo = repo;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(path, { method = 'GET', accept = 'application/vnd.github+json', body, etag } = {}) {
    const headers = { Authorization: `Bearer ${this.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
    if (etag) headers['If-None-Match'] = etag;
    if (body) headers['Content-Type'] = 'application/json';
    let response;
    try {
      // no-store: GitHub lets browsers cache these for a minute, which would hide a save that just happened.
      response = await this.fetch(`${API}/repos/${this.repo}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch (error) {
      throw new OfflineError('No connection');
    }
    if (response.status === 401) throw new AuthError('GitHub did not accept the access key. It may have expired.');
    if (response.status === 403) throw new AuthError('The access key is not allowed to read this repository.');
    if (response.status === 404) throw new MissingError('Not found');
    if (response.status === 409 || response.status === 422) throw new ConflictError('The file changed underneath us');
    if (response.status >= 500) throw new OfflineError(`GitHub is having trouble (${response.status})`);
    return response;
  }

  async check() {
    await this.request('');
  }

  // Returns { site, etag }, or { unchanged: true } when the stored copy is still current.
  async readSite(etag) {
    const response = await this.request('/contents/data/site.json', { accept: 'application/vnd.github.raw+json', etag });
    if (response.status === 304) return { unchanged: true };
    return { site: await response.json(), etag: response.headers.get('ETag') };
  }

  async readUser() {
    try {
      const response = await this.request('/contents/data/user.json');
      const file = await response.json();
      return { user: normalizeUser(JSON.parse(decodeBase64(file.content))), sha: file.sha };
    } catch (error) {
      if (error instanceof MissingError) return { user: emptyUser(), sha: null };
      throw error;
    }
  }

  async writeUser(user, sha) {
    const body = { message: 'user: update from Deck', content: encodeBase64(`${JSON.stringify(user, null, 1)}\n`) };
    if (sha) body.sha = sha;
    const response = await this.request('/contents/data/user.json', { method: 'PUT', body });
    return (await response.json()).content.sha;
  }
}

function readStored(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or a full disk: the page still works, it just will not remember.
  }
}

export class Store {
  constructor({ storage, fetchImpl, timers = globalThis, filesFactory } = {}) {
    this.storage = storage;
    this.timers = timers;
    this.filesFactory = filesFactory || ((repo, token) => new GitHubFiles(repo, token, fetchImpl));
    this.listeners = new Set();

    this.auth = readStored(storage, KEY.auth, null);
    this.files = this.auth ? this.filesFactory(this.auth.repo, this.auth.token) : null;
    const cache = readStored(storage, KEY.cache, {});
    this.site = cache.site || null;
    this.serverUser = normalizeUser(cache.user);
    this.userSha = cache.sha || null;
    this.etag = cache.etag || null;
    this.pending = readStored(storage, KEY.pending, []);

    // "New since your last visit": `before` is when the previous visit began. See markVisit.
    const seen = readStored(storage, KEY.seen, null);
    this.seen = seen && typeof seen === 'object' ? seen : { at: null, before: null };
    this.seenBefore = this.seen.before;
    this.demo = false;
    this.sync = this.pending.length ? 'saving' : 'idle';
    this.error = '';
    this.loaded = !!cache.site;
    this.saveTimer = null;
    this.retry = 0;
    this.flushing = false;
  }

  static demo(data, options = {}) {
    const store = new Store({ storage: nullStorage(), ...options });
    store.demo = true;
    store.auth = { repo: 'demo/demo' };
    store.site = data.site;
    store.serverUser = normalizeUser(data.user);
    store.seenBefore = data.seenBefore ?? null;
    store.loaded = true;
    return store;
  }

  get signedIn() {
    return !!this.auth;
  }

  get user() {
    return applyOps(this.serverUser, this.pending);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(what) {
    for (const listener of this.listeners) listener(what);
  }

  // Opening the page starts a visit. Reloading within the hour is the same visit, so the
  // "New" badges you have not acted on yet do not vanish just because the page was refreshed.
  markVisit(nowMs) {
    if (this.demo) return;
    if (this.seen.at == null || nowMs - this.seen.at > VISIT_GAP) {
      this.seen = { at: nowMs, before: this.seen.at };
      writeStored(this.storage, KEY.seen, this.seen);
    }
    this.seenBefore = this.seen.before;
  }

  persist() {
    if (this.demo) return;
    writeStored(this.storage, KEY.cache, { site: this.site, user: this.serverUser, sha: this.userSha, etag: this.etag });
    writeStored(this.storage, KEY.pending, this.pending);
  }

  setSync(sync, error = '') {
    if (this.sync === sync && this.error === error) return;
    this.sync = sync;
    this.error = error;
    this.emit('sync');
  }

  async signIn(repoInput, token) {
    const repo = parseRepo(repoInput);
    if (!repo) throw new Error('That does not look like a repository. Use the form owner/name.');
    if (!token || !token.trim()) throw new Error('Paste the access key.');
    const files = this.filesFactory(repo, token.trim());
    try {
      await files.check();
    } catch (error) {
      if (error instanceof MissingError) throw new Error('GitHub cannot find that repository with this key. Check the name, and that the key was given access to it.');
      throw error;
    }
    this.auth = { repo, token: token.trim() };
    this.files = files;
    writeStored(this.storage, KEY.auth, this.auth);
    this.emit('auth');
    await this.refresh();
  }

  signOut() {
    for (const key of Object.values(KEY)) writeStored(this.storage, key, null);
    this.timers.clearTimeout(this.saveTimer);
    Object.assign(this, { auth: null, files: null, site: null, serverUser: emptyUser(), userSha: null, etag: null, pending: [], loaded: false, sync: 'idle', error: '' });
    this.emit('auth');
  }

  async refresh() {
    if (this.demo || !this.files) return;
    try {
      const [siteResult, userResult] = await Promise.all([
        this.files.readSite(this.etag).catch((error) => {
          if (error instanceof MissingError) return { site: null, etag: null }; // the first run has not happened yet
          throw error;
        }),
        // While a save is in flight its result is the truth; reading underneath it would race.
        this.flushing ? null : this.files.readUser(),
      ]);
      if (!siteResult.unchanged) {
        this.site = siteResult.site;
        this.etag = siteResult.etag;
      }
      if (userResult && !this.flushing) {
        this.serverUser = userResult.user;
        this.userSha = userResult.sha;
      }
      this.loaded = true;
      this.persist();
      if (this.sync === 'offline' || this.sync === 'error') this.setSync(this.pending.length ? 'saving' : 'idle');
      this.emit('data');
      if (this.pending.length) this.scheduleSave(0);
    } catch (error) {
      this.handleFailure(error);
    }
  }

  commit(...ops) {
    this.pending.push(...ops);
    if (this.demo) {
      this.serverUser = applyOps(this.serverUser, this.pending);
      this.pending = [];
      this.emit('data');
      return;
    }
    this.persist();
    this.setSync('saving');
    this.emit('data');
    this.scheduleSave(SAVE_DELAY);
  }

  scheduleSave(delay) {
    this.timers.clearTimeout(this.saveTimer);
    this.saveTimer = this.timers.setTimeout(() => this.flush(), delay);
  }

  async flush() {
    if (this.demo || this.flushing || !this.files || !this.pending.length) return;
    this.flushing = true;
    try {
      for (let attempt = 0; attempt < 4 && this.pending.length; attempt += 1) {
        const batch = this.pending.length;
        const next = prune(applyOps(this.serverUser, this.pending.slice(0, batch)), this.site);
        try {
          this.userSha = await this.files.writeUser(next, this.userSha);
          this.serverUser = next;
          this.pending = this.pending.slice(batch); // anything tapped during the save stays queued
          this.persist();
        } catch (error) {
          if (!(error instanceof ConflictError)) throw error;
          // Another device saved first. Take its version and replay ours on top.
          const latest = await this.files.readUser();
          this.serverUser = latest.user;
          this.userSha = latest.sha;
        }
      }
      this.retry = 0;
      if (this.pending.length) throw new ConflictError('Could not save after several attempts');
      this.setSync('idle');
      this.emit('data');
    } catch (error) {
      this.handleFailure(error);
    } finally {
      this.flushing = false;
    }
  }

  handleFailure(error) {
    if (error instanceof AuthError) {
      this.setSync('error', error.message);
      this.emit('auth-problem');
      return;
    }
    const offline = error instanceof OfflineError;
    this.setSync(offline ? 'offline' : 'error', offline ? '' : error.message || 'Something went wrong');
    if (this.pending.length) {
      this.scheduleSave(RETRY_DELAYS[Math.min(this.retry, RETRY_DELAYS.length - 1)]);
      this.retry += 1;
    }
  }
}

export function nullStorage() {
  return { getItem: () => null, setItem() {}, removeItem() {} };
}
