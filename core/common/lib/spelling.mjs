// The spelling service every app shares (Word, PowerPoint, OneNote; Excel can use it too):
//
//   const sp = spelling();
//   sp.check('recieve')                    -> false   (sync; a word not looked up yet counts as correct and is queued)
//   await sp.prepare(['recieve', 'team'])  -> every word is looked up (the cache is filled)
//   await sp.suggest('recieve', 6)         -> ['receive', 'relieve']
//   sp.misspellings(text, {session})       -> [{start, end, text}]   (the words of `text` that are wrong)
//   sp.addUserWord('Arkemis')              -> never reported again (kept by the app in prefs.userDictionary)
//   sp.ignoreAll(session, 'Quill')         -> not reported in that document session
//   sp.ignoreOnce(session, key)            -> not reported at one place (the caller's key for it)
//
// The en_US dictionary (nspell over dictionary-en, core/common/lib/spelling-engine.mjs) loads lazily on first
// use, in a worker (src/workers/spelling.ts) when the window can start one, else in the calling thread. A
// check never waits for it: words wait in a queue, are looked up in one batch, and `version` goes up (and
// subscribers are told) when the answers are in, so a page that drew without squiggles draws them then.
// Typing is never held up: only the words on screen are asked about, each once (answers are cached).
//
// Skipped as Office's defaults skip them (spelling-words.mjs): ALL CAPS words, words with numbers, one-letter
// words, internet and file addresses. The user dictionary and the ignore lists are never sent anywhere; the
// worker only ever sees words. Only US English ships (docs/spec/patches/*/spelling.json); text marked with
// another language, or "Do not check spelling", is the caller's to leave out.

import {wordsOf, isSkipped, normalizeWord} from './spelling-words.mjs';

export {wordsOf, isSkipped, isAddress, isAllCaps, hasDigit, normalizeWord} from './spelling-words.mjs';

/** The language tags the bundled dictionary checks (US English; text with no language is US English). */
export const isCheckedLanguage = lang => !lang || /^en([-_]US)?$/i.test(String(lang));

const CACHE_LIMIT = 200_000;

/**
 * A service over a transport {check(words) -> Promise<boolean[]>, suggest(word, n) -> Promise<string[]>}.
 * `spelling()` below is the shared one; tests build their own over a fake dictionary.
 */
export function createSpelling(transport) {
  /** word -> true when correct */
  const cache = new Map();
  const pending = new Set();
  const suggestions = new Map();
  const userExact = new Set();
  const userLower = new Set();
  const ignoredAll = new Map(); // session -> Set of lower-case words
  const ignoredOnce = new Map(); // session -> Set of keys
  const listeners = new Set();
  let version = 0;
  let inflight = null;
  let loaded = false;
  let broken = false;

  const bump = () => { version += 1; for (const f of [...listeners]) { try { f(version); } catch { /* a listener never breaks the service */ } } };
  const sessionSet = (m, session) => { let s = m.get(session); if (!s) { s = new Set(); m.set(session, s); } return s; };

  const isUser = word => userExact.has(word) || userLower.has(word.toLowerCase());
  const isIgnored = (word, session) => session !== undefined && ignoredAll.get(session)?.has(word.toLowerCase()) === true;

  async function flush() {
    const words = [...pending];
    pending.clear();
    if (!words.length) return;
    let answers;
    try { answers = await transport.check(words); } catch { broken = true; return; }
    loaded = true;
    if (cache.size > CACHE_LIMIT) cache.clear();
    words.forEach((w, i) => cache.set(w, answers[i] !== false));
    bump();
  }
  /** Look up everything queued, in batches, until nothing is waiting (a burst of checks in one tick is one batch). */
  function schedule() {
    if (inflight) return inflight;
    inflight = (async () => {
      await Promise.resolve();
      try { while (pending.size && !broken) await flush(); } finally { inflight = null; }
    })();
    return inflight;
  }

  const api = {
    /** Goes up each time answers arrive or the user dictionary or an ignore list changes. */
    get version() { return version; },
    /** Has the dictionary answered at least once? */
    get loaded() { return loaded; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /**
     * Is the word spelt correctly? Words Office skips, user-dictionary words and ignored words are correct. A word not
     * looked up yet counts as correct and is queued (see `prepare`, `version`).
     */
    check(word, session) {
      const w = normalizeWord(word);
      if (isSkipped(w) || isUser(w) || isIgnored(w, session)) return true;
      const hit = cache.get(w);
      if (hit !== undefined) return hit;
      if (broken) return true;
      pending.add(w);
      schedule();
      return true;
    },
    /** Every word is looked up and cached when this resolves. */
    async prepare(words) {
      const need = [...new Set((words ?? []).map(normalizeWord))].filter(w => !isSkipped(w) && !cache.has(w));
      if (!need.length || broken) return;
      for (const w of need) pending.add(w);
      await schedule();
    },
    /** Up to `n` corrections for `word`, best first. */
    async suggest(word, n = 8) {
      const w = normalizeWord(word);
      const key = `${n}:${w}`;
      const hit = suggestions.get(key);
      if (hit) return hit;
      let list = [];
      try { list = await transport.suggest(w, n); } catch { list = []; }
      loaded = true;
      list = list.filter(s => s && s !== w).slice(0, n);
      if (suggestions.size > 2000) suggestions.clear();
      suggestions.set(key, list);
      return list;
    },
    /** Is the answer for `word` known (looked up, or never looked up because Office skips it or the user dictionary has it)? */
    known(word, session) { const w = normalizeWord(word); return isSkipped(w) || isUser(w) || isIgnored(w, session) || cache.has(w) || broken; },
    /** The suggestions `suggest` already found for `word` (null when it has not): a menu's state reads them without waiting. */
    suggested(word, n = 8) { return suggestions.get(`${n}:${normalizeWord(word)}`) ?? null; },
    /** The misspelt words of `text`, from what is cached ([{start, end, text}]); unknown words are queued and count as correct. `skip(start, end)` leaves a range out (text marked "do not check"). */
    misspellings(text, opts = {}) {
      const out = [];
      for (const t of wordsOf(text)) {
        if (opts.skip && opts.skip(t.start, t.end)) continue;
        if (!api.check(t.text, opts.session)) out.push(t);
      }
      return out;
    },
    /** `misspellings` after every word of `text` has been looked up. */
    async misspellingsAll(text, opts = {}) {
      await api.prepare(wordsOf(text).map(t => t.text));
      return api.misspellings(text, opts);
    },

    /** Add to Dictionary: never reported again. */
    addUserWord(word) {
      const w = normalizeWord(word).trim();
      if (!w || /[\r\n]/.test(w) || w.length > 255) throw new Error('not a word');
      userExact.add(w);
      if (w === w.toLowerCase()) userLower.add(w);
      bump();
      return w;
    },
    removeUserWord(word) {
      const w = normalizeWord(word).trim();
      userExact.delete(w);
      userLower.delete(w.toLowerCase());
      bump();
    },
    /** The app's saved user dictionary (prefs.userDictionary) becomes the list; nothing happens when it's the one already held. */
    setUserWords(words) {
      const list = (Array.isArray(words) ? words : []).map(w => normalizeWord(w).trim()).filter(Boolean);
      if (list.length === userExact.size && list.every(w => userExact.has(w))) return;
      userExact.clear(); userLower.clear();
      for (const w of list) { userExact.add(w); if (w === w.toLowerCase()) userLower.add(w); }
      bump();
    },
    userWords() { return [...userExact]; },

    /** Ignore All: `word` (any case) is not reported in this document session. */
    ignoreAll(session, word) { sessionSet(ignoredAll, session).add(normalizeWord(word).toLowerCase()); bump(); },
    ignoredWords(session) { return [...(ignoredAll.get(session) ?? [])]; },
    /** Undo Ignore All: `word` is reported again in this document session. */
    unignoreAll(session, word) { ignoredAll.get(session)?.delete(normalizeWord(word).toLowerCase()); bump(); },
    /** Undo Ignore Once for the caller's `key`. */
    unignoreOnce(session, key) { ignoredOnce.get(session)?.delete(String(key)); bump(); },
    /** Ignore Once: the caller's `key` for one place in the document is not reported. */
    ignoreOnce(session, key) { sessionSet(ignoredOnce, session).add(String(key)); bump(); },
    isIgnoredOnce(session, key) { return ignoredOnce.get(session)?.has(String(key)) === true; },
    /** Recheck Document: Ignore Once and Ignore All start empty again. */
    recheck(session) { ignoredAll.delete(session); ignoredOnce.delete(session); bump(); },
    /** Forget a session's ignore lists (the document closed). */
    endSession(session) { ignoredAll.delete(session); ignoredOnce.delete(session); },
    /** Has this document session ignored anything (Ignore Once or Ignore All)? The panes say so when they report a complete check. */
    hasIgnored(session) { return (ignoredAll.get(session)?.size ?? 0) > 0 || (ignoredOnce.get(session)?.size ?? 0) > 0; },
    /** For tests: drop cached answers. */
    reset() { cache.clear(); suggestions.clear(); pending.clear(); loaded = false; broken = false; },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------
// The shared service: its transport is the spelling worker where the window can start one, else the engine in the calling thread.

let shared = null;
let worker = null;
let workerGaveUp = false;
let seq = 0;
const waiting = new Map();
let inThread = null;

function giveUpWorker() {
  workerGaveUp = true;
  try { worker?.terminate(); } catch { /* already gone */ }
  worker = null;
  for (const [, w] of waiting) w.reject(new Error('the spelling worker stopped'));
  waiting.clear();
}

function startWorker() {
  if (workerGaveUp || worker) return worker;
  if (typeof Worker !== 'function' || typeof document === 'undefined') { workerGaveUp = true; return null; }
  try {
    const w = new Worker('./spelling.js', {type: 'module'});
    w.onmessage = e => {
      const {id, ok, result, error} = e.data ?? {};
      const entry = waiting.get(id);
      if (!entry) return;
      waiting.delete(id);
      if (ok) entry.resolve(result); else entry.reject(new Error(error));
    };
    w.onerror = () => giveUpWorker();
    w.onmessageerror = () => giveUpWorker();
    worker = w;
  } catch { workerGaveUp = true; worker = null; }
  return worker;
}

const viaWorker = (w, msg) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, {resolve, reject}); w.postMessage({id, lang: 'en-US', ...msg}); });
async function engine() {
  if (!inThread) {
    // In a window this is the slow path (the dictionary takes about 0.7 s to load on the window's own thread): said once, so a worker that did not start is not silent.
    if (typeof document !== 'undefined' && typeof console !== 'undefined') console.warn('[spelling] the dictionary loads on the window thread: the spelling worker did not start');
    inThread = import('./spelling-engine.mjs').then(m => m.openEngine('en-US'));
  }
  return inThread;
}

const sharedTransport = {
  async check(words) {
    const w = startWorker();
    if (w) { try { return await viaWorker(w, {op: 'check', words}); } catch { /* the thread answers */ } }
    const e = await engine();
    return words.map(x => e.correct(x));
  },
  async suggest(word, n) {
    const w = startWorker();
    if (w) { try { return await viaWorker(w, {op: 'suggest', word, n}); } catch { /* the thread answers */ } }
    const e = await engine();
    return e.suggest(word, n);
  },
};

/** The shared spelling service (one per window; the dictionary loads on first use). */
export function spelling() {
  if (!shared) shared = createSpelling(sharedTransport);
  return shared;
}

const hostIds = new WeakMap();
let hostSeq = 0;
/**
 * The key a document's Ignore lists are kept under: the kernel session's host (one per session, the same object as `ctx.host` in a command and `session.host`
 * in a surface) and the document id, so two documents that share an id in different sessions never share a list.
 */
export function sessionKey(host, docId) {
  let id = 0;
  if (host && typeof host === 'object') { id = hostIds.get(host) ?? 0; if (!id) { id = ++hostSeq; hostIds.set(host, id); } }
  return `${id}:${docId ?? ''}`;
}

const watched = new WeakSet();
/**
 * A document's Ignore lists last as long as the document is open: when the kernel session reports `document.opened` or `document.closed` for a document,
 * its lists are dropped, so a new document that reuses an id (or the same file opened again) always starts with every misspelt word reported.
 */
export function watchSession(kernelSession) {
  if (!kernelSession || typeof kernelSession.subscribe !== 'function' || watched.has(kernelSession)) return;
  watched.add(kernelSession);
  kernelSession.subscribe(e => { if (e?.type === 'document.opened' || e?.type === 'document.closed') spelling().endSession(sessionKey(kernelSession.host, e.doc)); });
}

/** Keep the shared service's user dictionary and a session's ignore lists in step with an app's prefs (`ctx.prefs` / `session.prefs`). */
export function spellingFor(prefs) {
  const sp = spelling();
  sp.setUserWords(prefs?.userDictionary);
  return sp;
}

/** For tests: forget the shared service and any worker. */
export function resetSpelling() { shared = null; giveUpWorker(); workerGaveUp = false; inThread = null; }
