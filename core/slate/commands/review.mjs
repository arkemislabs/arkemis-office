// Review tab: Thesaurus, Language and Password Protection (U:slate/review).
//
// Slate has no ArtCraft upstream: ids, args and summaries are docs/spec/slate.json `review.*` and
// `password.*`; behaviour is OneNote's Review tab:
//   * Thesaurus (Shift+F7) looks the word at the caret (or the selection, or `word`) up in the
//     built-in offline thesaurus and shows its meanings in the results pane; choosing a synonym
//     replaces the word (`replace`);
//   * Set Proofing Language marks the selected text (or the word at the caret) with a language, or
//     "Do not check spelling or grammar";
//   * Password Protection: Set Password protects the current section (its pages are encrypted at
//     rest, core/slate/lib/protect.mjs), Lock hides it again, Unlock asks for the password, Change
//     and Remove Password ask for the current password, Lock All (Ctrl+Alt+L) locks every
//     protected section. The password is a `secret` parameter: never journaled, never in a result,
//     never stored. These commands empty the undo stack (an undo must not bring a locked section back).
// Not offered, hidden with a note in docs/spec/patches/slate/review.json: Spelling, Accessibility
// Checker, Search (Smart Lookup), Translate, Linked Notes.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, schema} from '../schema.mjs';
import {currentLocation, selectPage, selectSection} from '../model/notebook.mjs';
import {charRange, editPage, markAttr, needRange, textRange, textState} from '../lib/format-text.mjs';
import {DEFAULT_LANGUAGE, LANGUAGE_NAMES, languageOf, matchCase, nameOfCode, synonymsOf} from '../lib/proofing.mjs';
import {MAX_PASSWORD, binEntriesOf, encryptPayload, forgetAllKeys, forgetKey, isLocked, isProtected, keyFor, newKey, openWith, payloadOf, rememberKey} from '../lib/protect.mjs';

import {LOCK_AFTER_PREF, LOCK_MINUTES_PREF, LOCK_NAVIGATE_PREF, LOCK_TIMES, idleSections, lockOptions, touch} from '../lib/autolock.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/review.*', 'docs/spec/slate.json#commands/password.*']};
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };
const here = ctx => currentLocation(ctx.doc, ctx.selection);
const binOf = c => (Array.isArray(c.notebook?.recycleBin) ? c.notebook.recycleBin : []);
const password = (o = {}) => s.secret({min: 1, max: MAX_PASSWORD, ...o});

function sectionOf(ctx, p) {
  need(isNotebook(ctx.doc), 'disabled', 'No notebook is open');
  const id = String(p.sectionId ?? here(ctx).sectionId ?? '').replace(/^\/sec:/, '');
  need(id, 'disabled', 'Open a section first');
  const section = ctx.doc.sections[id];
  need(section, 'not_found', `No section ${id}`, {address: `/sec:${id}`});
  return section;
}
const sectionState = (ctx, p, test) => {
  if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
  const id = String(p?.sectionId ?? here(ctx).sectionId ?? '').replace(/^\/sec:/, '');
  const section = id ? ctx.doc.sections[id] : null;
  if (!section) return {enabled: false, reason: 'Open a section first'};
  return test(section) ?? {enabled: true};
};

/** Put a decrypted payload back into the open notebook. */
function restore(ctx, section, payload) {
  const c = ctx.doc;
  const entries = payload.pages.filter(e => payload.records[e.id]);
  for (const e of entries) {
    need(!c.pages[e.id], 'failed', `Page ${e.id} of ${section.name} is already in the notebook`);
    ctx.change.set(['pages', e.id], payload.records[e.id]);
  }
  ctx.change.set(['sections', section.id, 'pages'], entries.map(e => ({id: e.id, level: e.level})));
  if (Object.keys(payload.versions ?? {}).length) ctx.change.set(['versions'], {...(c.versions ?? {}), ...payload.versions});
  if (payload.bin?.length) ctx.change.set(['notebook', 'recycleBin'], [...binOf(c), ...payload.bin]);
}

/** Take a section's pages, versions and bin entries out of the open notebook (after they were encrypted). */
function takeOut(ctx, section) {
  const c = ctx.doc;
  const ids = section.pages.map(e => e.id);
  for (const id of ids) ctx.change.delete(['pages', id]);
  if (c.versions && ids.some(id => c.versions[id])) {
    const next = {...c.versions};
    for (const id of ids) delete next[id];
    ctx.change.set(['versions'], next);
  }
  const gone = new Set(binEntriesOf(c, section.id));
  if (gone.size) ctx.change.set(['notebook', 'recycleBin'], binOf(c).filter(e => !gone.has(e)));
  ctx.change.set(['sections', section.id, 'pages'], []);
}

/** Close the panes and the selection that show what is about to leave. */
function leave(ctx, section) {
  const ids = new Set(section.pages.map(e => e.id));
  const v = ctx.view ?? {};
  const patch = {};
  if (v.pane && (v.pane.kind === 'versions' || v.pane.kind === 'recycle' || v.pane.kind === 'recent' || v.pane.kind === 'authors')) patch.pane = null;
  if (v.versionView && ids.has(v.versionView.page)) patch.versionView = null;
  if (Object.keys(patch).length) ctx.setView(patch);
  if (ids.has(here(ctx).pageId)) ctx.setSelection(selectSection(section.id));
}

async function lockSection(ctx, section, key) {
  const blob = await encryptPayload(key, section.protection, payloadOf(ctx.doc, section.id));
  leave(ctx, section);
  takeOut(ctx, section);
  ctx.change.set(['sections', section.id, 'protection'], blob);
  ctx.change.set(['sections', section.id, 'locked'], true);
}

const wrong = (field = 'password') => new CommandError('invalid_params', 'The password is not correct.', {path: `/${field}`, fields: [{field, message: 'The password is not correct.'}]});

/** The word to look up: `word`, else the selection (its first word) or the word at the caret. */
function lookupTarget(ctx, word) {
  if (word) return {word, range: textRange(ctx) ? charRange(textRange(ctx)) : null, range0: textRange(ctx)};
  const range = textRange(ctx);
  if (!range) return {word: '', range: null, range0: null};
  const r = charRange(range);
  const text = r ? range.doc.textBetween(r.from, r.to, ' ', ' ') : '';
  return {word: text.trim().split(/\s+/)[0] ?? '', range: r, range0: range};
}

export const languageAt = (doc, from, to) => {
  const a = markAttr(doc, from, to, schema.marks.language, 'lang');
  return a ? {name: nameOfCode(a) ?? a, code: a, doNotCheck: markAttr(doc, from, to, schema.marks.language, 'noCheck') === true} : {name: DEFAULT_LANGUAGE, code: 'en-US', doNotCheck: false};
};

export default defineCommands({
  family: 'review',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    // --- Thesaurus ----------------------------------------------------------------------------------
    {
      id: 'review.thesaurus', label: 'Thesaurus', shortcut: 'Shift+F7', risk: 'edit', effect: 'content',
      description: 'Look up synonyms of a word (word, else the selection or the word at the caret) in the built-in offline thesaurus, shown in a pane; with `replace`, put that synonym in place of the word at the caret or the selection.',
      params: s.object({word: s.optional(s.string({min: 1, max: 80})), replace: s.optional(s.string({min: 1, max: 80}))}),
      state: ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'}),
      run(ctx, p) {
        const t = lookupTarget(ctx, p.word);
        const found = synonymsOf(t.word);
        if (p.replace) {
          const range = needRange(ctx);
          const r = charRange(range);
          need(r, 'disabled', 'Put the caret in a word or select the word to replace');
          const original = range.doc.textBetween(r.from, r.to, ' ', ' ');
          need(original.trim(), 'disabled', 'There is no word to replace');
          const text = matchCase(original, p.replace.trim());
          const marks = range.doc.resolve(r.from).marksAcross(range.doc.resolve(r.to)) ?? [];
          editPage(ctx, range.pageId, tr => tr.replaceWith(r.from, r.to, schema.text(text, marks)), range.doc);
          ctx.setView({pane: {kind: 'thesaurus', word: found.word}});
          return {replaced: original, with: text};
        }
        ctx.setView({pane: {kind: 'thesaurus', word: found.word}});
        return found;
      },
    },

    // --- Language -----------------------------------------------------------------------------------
    {
      id: 'review.setLanguage', label: 'Set Proofing Language', risk: 'edit', dialog: 'dialog.language',
      description: `Mark the selected text (or the word at the caret) with a proofing language (${LANGUAGE_NAMES.join(', ')} or a tag such as en-GB); doNotCheck marks it "Do not check spelling or grammar".`,
      params: s.object({language: s.string({min: 2, max: 40}), doNotCheck: s.optional(s.boolean())}),
      state(ctx) {
        const range = textRange(ctx);
        if (!range) return textState(ctx);
        const r = charRange(range) ?? range;
        const l = languageAt(range.doc, r.from, r.to);
        return {enabled: true, value: l.name, checked: l.doNotCheck ? 'mixed' : undefined};
      },
      run(ctx, p) {
        const range = needRange(ctx);
        const r = charRange(range);
        if (!r) return {changed: 0, reason: 'The caret is not in a word'};
        const lang = languageOf(p.language);
        need(lang, 'invalid_params', `${p.language} is not a language this app can mark; choose one of ${LANGUAGE_NAMES.join(', ')}`, {path: '/language'});
        const noCheck = p.doNotCheck === true;
        const type = schema.marks.language;
        editPage(ctx, range.pageId, tr => {
          tr.removeMark(r.from, r.to, type);
          if (noCheck || lang.name !== DEFAULT_LANGUAGE) tr.addMark(r.from, r.to, type.create({lang: lang.code, noCheck}));
        }, range.doc);
        return {changed: r.to - r.from, language: lang.name, code: lang.code, doNotCheck: noCheck};
      },
    },

    // --- Password Protection --------------------------------------------------------------------------
    {
      id: 'review.password', label: 'Password', risk: 'read', effect: 'view', dialog: 'dialog.password-protection',
      description: 'Open the Password Protection pane for the current section (Set, Change or Remove Password, Lock All). Returns every section with whether it is protected and locked.',
      params: s.object({}),
      state: ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'}),
      run(ctx) {
        const sections = Object.values(ctx.doc.sections).map(x => ({id: x.id, name: x.name, protected: isProtected(x), locked: isLocked(x)}));
        return {current: here(ctx).sectionId, sections};
      },
    },
    {
      id: 'password.set', label: 'Set Password', risk: 'edit', effect: 'content', undo: 'auto', clearsHistory: true, repeatable: false, journal: true, dialog: 'dialog.password-set',
      description: 'Password-protect a section (default: the current one). Its pages are encrypted in the notebook folder; the section stays open until it is locked. The password is never stored: it cannot be recovered if it is lost.',
      params: s.object({sectionId: s.optional(s.string({max: 120})), password: password()}),
      state: (ctx, p) => sectionState(ctx, p, x => (isProtected(x) ? {enabled: false, reason: `${x.name} is already password protected`} : null)),
      async run(ctx, p) {
        const section = sectionOf(ctx, p);
        need(!isProtected(section), 'disabled', `${section.name} is already password protected`);
        const made = await newKey(p.password);
        const blob = await encryptPayload(made.key, made, payloadOf(ctx.doc, section.id));
        ctx.change.set(['sections', section.id, 'protection'], blob);
        rememberKey(ctx.doc, section.id, made.key);
        touch(ctx.doc, section.id, ctx.host.now());
        return {section: `/sec:${section.id}`, protected: true, locked: false};
      },
    },
    {
      id: 'password.change', label: 'Change Password', risk: 'edit', effect: 'content', undo: 'auto', clearsHistory: true, repeatable: false, dialog: 'dialog.password-change',
      description: 'Change the password of a protected section (default: the current one); the old password is required, whether the section is locked or not.',
      params: s.object({sectionId: s.optional(s.string({max: 120})), oldPassword: password(), newPassword: password()}),
      state: (ctx, p) => sectionState(ctx, p, x => (isProtected(x) ? null : {enabled: false, reason: `${x.name} is not password protected`})),
      async run(ctx, p) {
        const section = sectionOf(ctx, p);
        need(isProtected(section), 'disabled', `${section.name} is not password protected`);
        const opened = await openWith(section, p.oldPassword);
        if (!opened) throw wrong('oldPassword');
        const made = await newKey(p.newPassword, section.protection.iterations);
        const payload = isLocked(section) ? opened.payload : payloadOf(ctx.doc, section.id);
        ctx.change.set(['sections', section.id, 'protection'], await encryptPayload(made.key, made, payload));
        if (!isLocked(section)) rememberKey(ctx.doc, section.id, made.key);
        return {section: `/sec:${section.id}`, changed: true, locked: isLocked(section)};
      },
    },
    {
      id: 'password.remove', label: 'Remove Password', risk: 'edit', effect: 'content', undo: 'auto', clearsHistory: true, repeatable: false, dialog: 'dialog.password-remove',
      description: 'Remove the password of a protected section (default: the current one); the password is required. The section is no longer encrypted in the notebook folder.',
      params: s.object({sectionId: s.optional(s.string({max: 120})), password: password()}),
      state: (ctx, p) => sectionState(ctx, p, x => (isProtected(x) ? null : {enabled: false, reason: `${x.name} is not password protected`})),
      async run(ctx, p) {
        const section = sectionOf(ctx, p);
        need(isProtected(section), 'disabled', `${section.name} is not password protected`);
        const opened = await openWith(section, p.password);
        if (!opened) throw wrong();
        if (isLocked(section)) restore(ctx, section, opened.payload);
        ctx.change.delete(['sections', section.id, 'protection']);
        ctx.change.delete(['sections', section.id, 'locked']);
        forgetKey(ctx.doc, section.id);
        return {section: `/sec:${section.id}`, protected: false};
      },
    },
    {
      id: 'password.unlock', label: 'Unlock Section', risk: 'edit', effect: 'content', undo: 'auto', clearsHistory: true, repeatable: false, dialog: 'dialog.password-unlock',
      description: 'Unlock a password-protected section (default: the current one) with its password; its pages are decrypted into the open notebook until it is locked again.',
      params: s.object({sectionId: s.optional(s.string({max: 120})), password: password()}),
      state: (ctx, p) => sectionState(ctx, p, x => (isLocked(x) ? null : {enabled: false, reason: isProtected(x) ? `${x.name} is not locked` : `${x.name} is not password protected`})),
      async run(ctx, p) {
        const section = sectionOf(ctx, p);
        need(isLocked(section), 'disabled', isProtected(section) ? `${section.name} is not locked` : `${section.name} is not password protected`);
        const opened = await openWith(section, p.password);
        if (!opened) throw wrong();
        restore(ctx, section, opened.payload);
        ctx.change.set(['sections', section.id, 'locked'], false);
        rememberKey(ctx.doc, section.id, opened.key);
        touch(ctx.doc, section.id, ctx.host.now());
        const first = opened.payload.pages.find(e => opened.payload.records[e.id])?.id;
        ctx.setSelection(first ? selectPage(first) : selectSection(section.id));
        return {section: `/sec:${section.id}`, locked: false, pages: opened.payload.pages.length};
      },
    },
    {
      id: 'password.lock', label: 'Lock Section', risk: 'edit', effect: 'content', undo: 'auto', clearsHistory: true, repeatable: false,
      description: 'Lock an unlocked password-protected section (default: the current one): its pages are encrypted and leave the open notebook until it is unlocked.',
      params: s.object({sectionId: s.optional(s.string({max: 120}))}),
      state: (ctx, p) => sectionState(ctx, p, x => (!isProtected(x) ? {enabled: false, reason: `${x.name} is not password protected`} : isLocked(x) ? {enabled: false, reason: `${x.name} is already locked`} : null)),
      async run(ctx, p) {
        const section = sectionOf(ctx, p);
        need(isProtected(section), 'disabled', `${section.name} is not password protected`);
        if (isLocked(section)) return {section: `/sec:${section.id}`, locked: true, changed: false};
        await lockSection(ctx, section, keyOf(ctx, section));
        forgetKey(ctx.doc, section.id);
        return {section: `/sec:${section.id}`, locked: true, changed: true};
      },
    },
    {
      id: 'review.passwordOptions', label: 'Password Options', risk: 'read', effect: 'prefs', dialog: 'dialog.password-options',
      description: `Password Options: lock password-protected sections after \`minutes\` (${LOCK_TIMES.map(t => t[1]).join(', ')}) in which nothing was done in them (lockAfter), and/or as soon as another section is opened (onNavigate). Without params it reports the options.`,
      params: s.object({lockAfter: s.optional(s.boolean()), minutes: s.optional(s.integer({min: 1, max: 1440})), onNavigate: s.optional(s.boolean())}),
      state: ctx => (isNotebook(ctx.doc) ? {enabled: true, value: lockOptions(ctx.prefs)} : {enabled: false, reason: 'No notebook is open'}),
      run(ctx, p) {
        need(p.minutes === undefined || LOCK_TIMES.some(t => t[1] === p.minutes), 'invalid_params', `Choose one of ${LOCK_TIMES.map(t => t[0]).join(', ')}`, {path: '/minutes'});
        const patch = {};
        if (p.lockAfter !== undefined) patch[LOCK_AFTER_PREF] = p.lockAfter;
        if (p.minutes !== undefined) patch[LOCK_MINUTES_PREF] = p.minutes;
        if (p.onNavigate !== undefined) patch[LOCK_NAVIGATE_PREF] = p.onNavigate;
        if (Object.keys(patch).length) ctx.updatePrefs(patch);
        return lockOptions({...ctx.prefs, ...patch});
      },
    },
    {
      id: 'password.autoLock', label: 'Lock Idle Sections', risk: 'edit', effect: 'content', undo: 'auto', clearsHistory: true, repeatable: false, journal: false,
      description: 'Lock every unlocked password-protected section in which nothing was done for the Password Options time (the surface runs this every few seconds). Returns the sections locked.',
      params: s.object({}),
      state: ctx => (isNotebook(ctx.doc) && Object.values(ctx.doc.sections).some(x => isProtected(x) && !isLocked(x)) && lockOptions(ctx.prefs).lockAfter
        ? {enabled: true} : {enabled: false, reason: 'No section would be locked by time'}),
      async run(ctx) {
        const out = [];
        for (const id of idleSections(ctx.doc, ctx.prefs, ctx.host.now())) {
          const section = ctx.doc.sections[id];
          await lockSection(ctx, section, keyOf(ctx, section));
          forgetKey(ctx.doc, id);
          out.push(`/sec:${id}`);
        }
        return {locked: out};
      },
    },
    {
      id: 'password.lockAll', label: 'Lock All', shortcut: 'Mod+Alt+L', risk: 'edit', effect: 'content', undo: 'auto', clearsHistory: true, repeatable: false,
      description: 'Lock every unlocked password-protected section of the notebook.',
      params: s.object({}),
      state: ctx => {
        if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
        return Object.values(ctx.doc.sections).some(x => isProtected(x) && !isLocked(x)) ? {enabled: true} : {enabled: false, reason: 'No password-protected section is unlocked'};
      },
      async run(ctx) {
        const open = Object.values(ctx.doc.sections).filter(x => isProtected(x) && !isLocked(x));
        const out = [];
        for (const section of open) {
          await lockSection(ctx, section, keyOf(ctx, section));
          forgetKey(ctx.doc, section.id);
          out.push(`/sec:${section.id}`);
        }
        forgetAllKeys(ctx.doc);
        return {locked: out};
      },
    },
  ],
});

function keyOf(ctx, section) {
  const key = keyFor(ctx.doc, section.id);
  need(key, 'failed', `${section.name} cannot be locked: its key is not in memory. Remove the password and set it again.`);
  return key;
}
