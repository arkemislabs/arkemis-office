// Panes and settings with no Office service behind them (U:slate/rest): Search, Check Accessibility,
// Help, Show Training, What's New, Linked Notes, Audio & Video Settings and Touch Mode.
//
// Slate has no ArtCraft upstream; ids and args are docs/spec/slate.json `search.*`, `review.*`,
// `help.*`, `view.touchMode`. Each is OneNote's control made to work on this machine alone:
//   * Search (Review > Insights) and `search.all` find the selected (or typed) words on pages, in
//     titles, in the text of scanned pictures and in file names, in the page, section, group or
//     notebook, in a results pane (core/slate/lib/search.mjs). Smart Lookup on the web is not offered;
//   * Check Accessibility lists the page's errors, warnings and tips in a pane; selecting one goes
//     to its object (core/slate/lib/accessibility.mjs);
//   * Help, Show Training and What's New open a pane of topics, lessons and release notes kept in the
//     app (core/slate/lib/help.mjs); Contact Support and Feedback need Microsoft's services;
//   * Linked Notes starts a page, in the section you pick, of notes about a file on this computer,
//     with a link to the file at the top. The app cannot watch another program's window, so the
//     notes are not docked beside it;
//   * Audio & Video Settings choose the microphone, the camera and the recording quality
//     (`slate.avSettings`, read when a recording starts); Touch Mode makes the page's own controls
//     larger (`slate.touchMode`).
// Not checked against upstream (there is none).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, nodeOf, schema} from '../schema.mjs';
import {addPage, currentLocation, selectPage} from '../model/notebook.mjs';
import {insertContainer, pageDoc} from '../model/canvas.mjs';
import {blockIndex} from '../model/page.mjs';
import {charRange, editPage, textRange} from '../lib/format-text.mjs';
import {SEARCH_SCOPES, searchNotebook} from '../lib/search.mjs';
import {checkPage, countByLevel} from '../lib/accessibility.mjs';
import {HELP_TOPICS, TRAINING, WHATS_NEW} from '../lib/help.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/search.*', 'docs/spec/slate.json#commands/review.checkAccessibility',
  'docs/spec/slate.json#commands/help.*', 'docs/spec/slate.json#commands/view.touchMode', 'docs/spec/slate.json#commands/review.linkedNotes']};
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };
const ready = ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'});

export const AV_PREF = 'slate.avSettings';
export const TOUCH_PREF = 'slate.touchMode';
export const AV_QUALITY = Object.freeze({low: 32_000, medium: 64_000, high: 128_000});
export const VIDEO_SIZES = Object.freeze({small: {width: 320, height: 240}, medium: {width: 640, height: 480}, large: {width: 1280, height: 720}});
/** The recording settings the person chose, with their defaults. */
export function avSettings(prefs) {
  const v = prefs?.[AV_PREF] && typeof prefs[AV_PREF] === 'object' ? prefs[AV_PREF] : {};
  return {
    audioInput: typeof v.audioInput === 'string' ? v.audioInput : '', videoInput: typeof v.videoInput === 'string' ? v.videoInput : '',
    audioQuality: Object.hasOwn(AV_QUALITY, v.audioQuality) ? v.audioQuality : 'medium', videoSize: Object.hasOwn(VIDEO_SIZES, v.videoSize) ? v.videoSize : 'medium',
  };
}
/** What the recorder is asked for: device ids, the audio bit rate, the video frame size. */
export function recordOptions(prefs) {
  const a = avSettings(prefs);
  return {audioInput: a.audioInput || null, videoInput: a.videoInput || null, audioBitsPerSecond: AV_QUALITY[a.audioQuality], ...VIDEO_SIZES[a.videoSize]};
}

/** The file:// address of a path on this computer. */
export function fileUrl(path) {
  const p = String(path ?? '').replace(/\\/g, '/');
  need(p, 'invalid_params', 'Choose a file to link the notes to', {path: '/path'});
  return `file://${p.startsWith('/') ? '' : '/'}${encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

/** The first words of the selection, as the Search query. */
function selectedWords(ctx) {
  const range = textRange(ctx);
  if (!range) return '';
  const r = charRange(range) ?? range;
  try { return range.doc.textBetween(r.from, r.to, ' ', ' ').replace(/\s+/g, ' ').trim().slice(0, 200); } catch { return ''; }
}

const searchParams = s.object({query: s.optional(s.string({max: 200})), scope: s.optional(s.enum(SEARCH_SCOPES))});
function runSearch(ctx, p) {
  const loc = currentLocation(ctx.doc, ctx.selection);
  const query = (p.query ?? '').trim() || selectedWords(ctx);
  const scope = p.scope ?? 'notebook';
  ctx.setView({pane: {kind: 'search', query, scope}});
  return searchNotebook(ctx.doc, query, {sectionId: loc.sectionId, pageId: loc.pageId, scope});
}

export default defineCommands({
  family: 'rest-panes',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    // --- Search -------------------------------------------------------------------------------------
    {
      id: 'review.smartLookup', label: 'Search', risk: 'read', effect: 'view',
      description: 'Search the notebook for the selected words (or `query`) and show the pages that hold them in the Search pane. Offline: it does not look anything up on the web.',
      params: searchParams, state: ready, run: runSearch,
    },
    {
      id: 'search.all', label: 'Search Notebooks', shortcut: 'Mod+E', risk: 'read', effect: 'view',
      description: 'Find a word or phrase on pages, in titles, in the text of scanned pictures and in file names: in this page, section, section group or notebook (default). Sections locked with a password are not read.',
      params: searchParams, state: ready, run: runSearch,
    },

    // --- Accessibility ------------------------------------------------------------------------------
    {
      id: 'review.checkAccessibility', label: 'Check Accessibility', risk: 'read', effect: 'view',
      description: 'Check the page for what makes it hard to use with a screen reader or low vision and list it in the Accessibility pane: errors (pictures without alternative text, no page title), warnings (a table without a header row, low contrast, ink with no typed text) and tips.',
      params: s.object({}),
      state(ctx) {
        const st = ready(ctx);
        if (!st.enabled) return st;
        return currentLocation(ctx.doc, ctx.selection).pageId ? {enabled: true} : {enabled: false, reason: 'No page is open'};
      },
      run(ctx) {
        const {pageId} = currentLocation(ctx.doc, ctx.selection);
        need(pageId && ctx.doc.pages[pageId], 'disabled', 'No page is open');
        const issues = checkPage(ctx.doc.pages[pageId]);
        ctx.setView({pane: {kind: 'accessibility', page: pageId}});
        return {page: `/pg:${pageId}`, counts: countByLevel(issues), issues};
      },
    },
    {
      id: 'review.accessibilitySelect', label: 'Go to Issue', risk: 'read', effect: 'view', undo: 'none',
      description: 'Select the object an Accessibility Checker issue is about (its address).',
      params: s.object({address: s.string({min: 1, max: 4096})}),
      state: ready,
      run(ctx, p) {
        const m = /^\/pg:([^/]+)(?:\/(b|media):([^/]+))?$/.exec(p.address);
        need(m, 'invalid_params', 'An issue address is /pg:<page>, /pg:<page>/b:<id> or /pg:<page>/media:<id>', {path: '/address'});
        const pageId = decodeURIComponent(m[1]);
        need(ctx.doc.pages[pageId], 'not_found', `No page ${pageId}`);
        if (!m[2]) { ctx.setSelection(selectPage(pageId)); return {selected: `/pg:${pageId}`}; }
        const id = decodeURIComponent(m[3]);
        const hit = blockIndex(pageDoc(ctx, pageId)).get(id);
        need(hit, 'not_found', `No ${m[2]} ${id} on that page (it was changed)`, {path: '/address'});
        const a = hit.node.isTextblock ? `/pg:${pageId}/b:${id}/t:0` : p.address;
        ctx.setSelection({ranges: [{anchor: a, focus: a}], primary: 0});
        return {selected: a};
      },
    },

    // --- Help ---------------------------------------------------------------------------------------
    {
      id: 'help.show', label: 'Help', shortcut: 'F1', risk: 'read', effect: 'view',
      description: 'Open the Help pane: topics about what the app does, written for this app and kept in it (searchable with `query`; `topic` opens one).',
      params: s.object({query: s.optional(s.string({max: 100})), topic: s.optional(s.enum(HELP_TOPICS.map(t => t.id)))}),
      state: ready,
      run(ctx, p) { ctx.setView({pane: {kind: 'help', tab: 'topics', query: p.query ?? '', topic: p.topic ?? null}}); return {topics: HELP_TOPICS.map(t => t.id)}; },
    },
    {
      id: 'help.training', label: 'Show Training', risk: 'read', effect: 'view',
      description: 'Open the Help pane on the short lessons for the first hour, each a few steps to try.',
      params: s.object({}), state: ready,
      run(ctx) { ctx.setView({pane: {kind: 'help', tab: 'training', query: '', topic: null}}); return {lessons: TRAINING.map(t => t.id)}; },
    },
    {
      id: 'help.whatsNew', label: "What's New", risk: 'read', effect: 'view',
      description: 'Open the Help pane on what the latest version added.',
      params: s.object({}), state: ready,
      run(ctx) { ctx.setView({pane: {kind: 'help', tab: 'new', query: '', topic: null}}); return {items: WHATS_NEW.map(t => t.title)}; },
    },

    // --- Linked Notes -------------------------------------------------------------------------------
    {
      id: 'review.linkedNotes', label: 'Linked Notes', risk: 'edit', dialog: 'dialog.select-location',
      description: 'Start a page of notes about a file on this computer: a new page in the section you pick (`sectionId`; default the open one), titled "Notes: <file>", with a link to the file at the top. With `pageId` the link is added to that page instead. The notes are not docked beside the file.',
      params: s.object({
        sectionId: s.optional(s.string({min: 1, max: 80})), pageId: s.optional(s.string({min: 1, max: 80})),
        name: s.optional(s.string({min: 1, max: 255, description: 'The file\'s name'})), path: s.string({min: 1, max: 2048, description: 'The file\'s path on this computer'}),
      }),
      state: ready,
      run(ctx, p) {
        const url = fileUrl(p.path);
        const name = (p.name ?? p.path.replace(/\\/g, '/').split('/').pop() ?? 'File').slice(0, 200);
        let pageId = p.pageId;
        if (pageId) need(ctx.doc.pages[pageId], 'not_found', `No page ${pageId}`, {path: '/pageId'});
        else {
          const sectionId = p.sectionId ?? currentLocation(ctx.doc, ctx.selection).sectionId;
          need(sectionId && ctx.doc.sections[sectionId], 'disabled', p.sectionId ? `No section ${p.sectionId}` : 'Open a section first');
          pageId = addPage(ctx, sectionId, {title: `Notes: ${name}`.slice(0, 255)});
        }
        const doc = pageDoc(ctx, pageId);
        const y = Math.max(96, ...[...blockIndex(doc).values()].filter(h => h.node.type.name === 'container').map(h => h.node.attrs.y + 60));
        const r = insertContainer(ctx, pageId, {x: 48, y: pageId === p.pageId ? y : 96, width: null, text: 'Linked file: '});
        const fresh = pageDoc(ctx, pageId);
        const block = blockIndex(fresh).get(r.paragraph);
        const link = schema.marks.link.create({href: url});
        editPage(ctx, pageId, tr => { tr.insert(block.pos + 1 + block.node.content.size, schema.text(name, [link])); }, fresh);
        ctx.setSelection(selectPage(pageId));
        return {page: `/pg:${pageId}`, link: url, name};
      },
    },

    // --- Audio & Video Settings ---------------------------------------------------------------------
    {
      id: 'media.settings', label: 'Audio & Video Settings', risk: 'edit', effect: 'prefs', undo: 'none', dialog: 'dialog.audio-video-settings',
      description: 'Choose what recordings are made with: the microphone (`audioInput`, a device id; empty is the system default), the camera (`videoInput`), the audio quality (low 32, medium 64 or high 128 kbit/s) and the video size (small 320x240, medium 640x480 or large 1280x720). Read when a recording starts; one already running is not changed.',
      params: s.object({
        audioInput: s.optional(s.string({max: 512})), videoInput: s.optional(s.string({max: 512})),
        audioQuality: s.optional(s.enum(Object.keys(AV_QUALITY))), videoSize: s.optional(s.enum(Object.keys(VIDEO_SIZES))),
      }),
      state: ctx => ({...ready(ctx), value: avSettings(ctx.prefs)}),
      run(ctx, p) {
        const next = {...avSettings(ctx.prefs), ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))};
        ctx.updatePrefs({[AV_PREF]: next});
        return next;
      },
    },

    // --- Touch Mode ---------------------------------------------------------------------------------
    {
      id: 'view.touchMode', label: 'Touch/Mouse Mode', risk: 'read', effect: 'prefs',
      description: 'Switch between mouse and touch: touch makes the page tabs, the page list, the note containers\' handles and the panes larger so a finger can use them; the ribbon is not changed.',
      params: s.object({mode: s.optional(s.enum(['mouse', 'touch']))}),
      state: (ctx, p) => (isNotebook(ctx.doc) ? {enabled: true, checked: (ctx.prefs?.[TOUCH_PREF] === 'touch' ? 'touch' : 'mouse') === (p?.mode ?? (ctx.prefs?.[TOUCH_PREF] === 'touch' ? 'touch' : 'mouse'))} : ready(ctx)),
      run(ctx, p) {
        const mode = p.mode ?? (ctx.prefs?.[TOUCH_PREF] === 'touch' ? 'mouse' : 'touch');
        ctx.updatePrefs({[TOUCH_PREF]: mode});
        return {mode};
      },
    },
  ],
});

void nodeOf;
