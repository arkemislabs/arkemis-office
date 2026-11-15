// Automatic locking of password-protected sections (Review > Password > Password Options; U:slate/review).
// OneNote's two options: lock a section after N minutes in which nothing was done in it, and lock it
// as soon as the person navigates to another section. Slate has no ArtCraft upstream.
//
//   * `watchActivity(session, docId, now)` listens to the document: every change or selection move
//     in an unlocked protected section is its activity (the section was "worked in"); moving to
//     another section with Lock on Navigate on locks the one left (password.lock);
//   * password.autoLock (a command, so a test can drive it with the host's clock) locks every
//     unlocked protected section idle for the chosen time; the surface calls it every few seconds.
// Activity is kept in memory only (never in the document, never on disk). The clock is the caller's:
// a test passes a fake one and never sleeps. No DOM, no Node built-ins.

import {isNotebook} from '../schema.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {isLocked, isProtected} from './protect.mjs';

export const LOCK_AFTER_PREF = 'slate.lockAfter';
export const LOCK_MINUTES_PREF = 'slate.lockAfterMinutes';
export const LOCK_NAVIGATE_PREF = 'slate.lockOnNavigate';
export const DEFAULT_MINUTES = 10;
/** The Password Options choices: label (the dialog's) and minutes. */
export const LOCK_TIMES = Object.freeze([['1 minute', 1], ['5 minutes', 5], ['10 minutes', 10], ['15 minutes', 15], ['30 minutes', 30], ['1 hour', 60], ['2 hours', 120],
  ['6 hours', 360], ['12 hours', 720], ['1 day', 1440]]);
export const minutesOf = label => LOCK_TIMES.find(([l]) => l === label)?.[1] ?? null;
export const labelOf = minutes => LOCK_TIMES.find(([, m]) => m === minutes)?.[0] ?? `${minutes} minutes`;

/** The options as the preferences hold them (OneNote's defaults: lock after 10 minutes, not on navigate). */
export function lockOptions(prefs) {
  const m = prefs?.[LOCK_MINUTES_PREF];
  return {lockAfter: prefs?.[LOCK_AFTER_PREF] !== false, minutes: Number.isFinite(m) && m >= 1 ? m : DEFAULT_MINUTES, onNavigate: prefs?.[LOCK_NAVIGATE_PREF] === true};
}

const worked = new Map();
const keyOf = (content, id) => `${content.notebook.id}/${id}`;
/** The section was worked in at `ms`. */
export const touch = (content, sectionId, ms) => { worked.set(keyOf(content, sectionId), ms); };
export const forgetActivity = (content, sectionId) => { worked.delete(keyOf(content, sectionId)); };

/** The unlocked protected sections whose last activity is `minutes` or more before `now` (one never seen counts as now). */
export function idleSections(content, prefs, now) {
  const {lockAfter, minutes} = lockOptions(prefs);
  if (!lockAfter || !isNotebook(content)) return [];
  const out = [];
  for (const s of Object.values(content.sections)) {
    if (!isProtected(s) || isLocked(s)) continue;
    const at = worked.get(keyOf(content, s.id));
    if (at === undefined) { touch(content, s.id, now); continue; }
    if (now - at >= minutes * 60_000) out.push(s.id);
  }
  return out;
}

/**
 * Follow the document: activity in an unlocked protected section, and (Lock on Navigate) the lock of a
 * section the person leaves. Returns the function that stops it. `now()` is the clock.
 */
export function watchActivity(session, docId, now = () => Date.now()) {
  let last = null;
  const here = () => {
    const d = session.get(docId);
    const c = d.file.content;
    if (!isNotebook(c)) return null;
    return {c, id: currentLocation(c, d.selection).sectionId};
  };
  try { last = here()?.id ?? null; } catch { /* closed */ }
  return session.subscribe(e => {
    if (e.doc !== docId || (e.type !== 'doc.changed' && e.type !== 'selection.changed')) return;
    let at;
    try { at = here(); } catch { return; }
    if (!at) return;
    const section = at.id ? at.c.sections[at.id] : null;
    if (section && isProtected(section) && !isLocked(section)) touch(at.c, section.id, now());
    if (at.id === last) return;
    const left = last ? at.c.sections[last] : null;
    last = at.id;
    if (left && isProtected(left) && !isLocked(left) && session.prefs?.[LOCK_NAVIGATE_PREF] === true) {
      void session.execute(docId, 'password.lock', {sectionId: left.id}, {origin: 'ui'}).catch(() => {});
    }
  });
}
