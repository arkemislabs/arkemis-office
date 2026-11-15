// defineCommands() and the command contract (docs/architecture.md section 5).
// Types live in command.d.mts. No DOM, no Node built-ins.

import {isSchema} from './schema.mjs';
import {isRisk, riskRank} from './risk.mjs';

export const APP_IDS = Object.freeze(['quill', 'grid', 'prism', 'folio', 'slate']);
export const ORIGINS = Object.freeze(['ui', 'shortcut', 'bridge', 'test', 'dialog']);
export const NEEDS = Object.freeze(['model', 'view', 'worker']);
export const EFFECTS = Object.freeze(['content', 'view', 'persist', 'prefs']);
export const SCOPES = Object.freeze(['doc', 'app']);
export const UPSTREAM_REPOS = Object.freeze(['wordcraft', 'gridcraft', 'deckcraft', 'printcraft', 'office']);

const ID_RE = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)+$/;

// ---------------------------------------------------------------------------------------------
// Shortcuts: "Mod+B", "Ctrl+Shift+>", "Ctrl++", "F4", "Ctrl+V / Shift+Insert"

const MODS = {ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt',
  cmd: 'meta', command: 'meta', meta: 'meta', win: 'meta', super: 'meta', mod: 'mod'};
const NAMED = new Map(Object.entries({
  enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', tab: 'Tab', space: 'Space', spacebar: 'Space',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert', home: 'Home', end: 'End',
  pageup: 'PageUp', pgup: 'PageUp', pagedown: 'PageDown', pgdn: 'PageDown', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', plus: '+', minus: '-', menu: 'Menu',
  contextmenu: 'Menu', apps: 'Menu', printscreen: 'PrintScreen', pause: 'Pause', scrolllock: 'ScrollLock', capslock: 'CapsLock',
  numlock: 'NumLock', clear: 'Clear', break: 'Pause', comma: ',', period: '.', slash: '/', backslash: '\\', semicolon: ';',
  quote: "'", backquote: '`', equal: '=', equals: '=', bracketleft: '[', bracketright: ']',
}));
const PUNCT = new Set([...'`-=[]\\;\',./+<>?:"{}|~!@#$%^&*()_']);

/** Parse one chord. Returns null for an unparseable string. */
export function parseChord(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  let key = null;
  if (s.endsWith('++')) { key = '+'; s = s.slice(0, -2); }
  else if (s === '+') return {ctrl: false, alt: false, shift: false, meta: false, mod: false, key: '+'};
  const parts = s ? s.split('+').map(p => p.trim()) : [];
  if (key === null) key = parts.pop();
  if (parts.some(p => !p)) return null;
  const chord = {ctrl: false, alt: false, shift: false, meta: false, mod: false, key: ''};
  for (const p of parts) {
    const m = MODS[p.toLowerCase()];
    if (!m || chord[m]) return null;
    chord[m] = true;
  }
  if (!key) return null;
  const low = key.toLowerCase().replace(/\s+/g, '');
  if (NAMED.has(low)) chord.key = NAMED.get(low);
  else if (MODS[low] && MODS[low] !== 'mod' && !parts.length) chord.key = {ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta'}[MODS[low]];
  else if (/^(left|right)(shift|ctrl|control|alt)$/.test(low)) chord.key = {shift: 'Shift', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt'}[low.replace(/^(left|right)/, '')];
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) chord.key = key.toUpperCase();
  else if (/^num(pad)?\s?[0-9*+\-./]$/i.test(key)) chord.key = 'Num' + key.slice(-1);
  else if (key.length === 1 && (/[a-z0-9]/i.test(key) || PUNCT.has(key))) chord.key = key.toUpperCase();
  else return null;
  return chord;
}

/**
 * All alternatives of a shortcut ("Ctrl+Y / Ctrl+Shift+Z", or an array). An alternative may be a
 * key sequence ("Alt, V, P": steps separated by commas); parenthetical notes ("(Mac Cmd+E)") are
 * ignored. Each entry is {text, steps, chord}: `steps` is the list of chords (null when a step
 * does not parse) and `chord` the single chord of a one-step shortcut (null otherwise).
 */
export function parseShortcut(shortcut) {
  const list = Array.isArray(shortcut) ? shortcut : typeof shortcut === 'string' ? shortcut.split(/\s+\/\s+|\s+or\s+/) : [];
  return list.map(x => {
    const text = String(x);
    const clean = text.replace(/\s*\([^)]*\)/g, '').trim();
    const parts = clean.split(/\s*,\s+/).filter(p => p.length);
    const steps = parts.length ? parts.map(parseChord) : [null];
    const ok = steps.every(Boolean);
    return {text, steps: ok ? steps : null, chord: ok && steps.length === 1 ? steps[0] : null, sequence: ok && steps.length > 1};
  });
}

/** Canonical text of a parsed alternative (a chord or a key sequence) for conflict checks. */
export function formatShortcut(entry, platform) {
  return entry.steps ? entry.steps.map(c => formatChord(c, platform)).join(', ') : entry.text;
}

/** Canonical chord text ("Mod+Shift+B"); `platform` 'mac' maps Mod to Meta, otherwise to Ctrl. */
export function formatChord(chord, platform) {
  const out = [];
  const mod = chord.mod ? (platform === 'mac' ? 'meta' : platform ? 'ctrl' : 'mod') : null;
  if (chord.ctrl || mod === 'ctrl') out.push('Ctrl');
  if (mod === 'mod') out.push('Mod');
  if (chord.alt) out.push('Alt');
  if (chord.shift) out.push('Shift');
  if (chord.meta || mod === 'meta') out.push('Meta');
  out.push(chord.key);
  return out.join('+');
}

// ---------------------------------------------------------------------------------------------
// Families

/** Defaults applied to a command spec: needs, undo, journal, scope, effect. */
export function normalizeCommand(c) {
  const effect = c.effect ?? (c.risk === 'read' ? 'view' : 'content');
  return {
    ...c,
    needs: c.needs ?? 'model',
    undo: c.undo ?? (c.risk !== 'read' && effect === 'content' ? 'auto' : 'none'),
    journal: c.journal ?? true,
    scope: c.scope ?? 'doc',
    effect,
  };
}

/**
 * Validate a family's shape. Returns a list of error strings (empty when valid). The generator
 * adds the path checks (family = path under commands/, app = folder).
 */
export function validateFamily(f, {where = 'command module', allowView = false} = {}) {
  const errors = [];
  const err = m => errors.push(`${where}: ${m}`);
  if (!f || typeof f !== 'object') { err('default export must be defineCommands({...})'); return errors; }
  if (typeof f.family !== 'string' || !/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/i.test(f.family)) err('`family` must be a path like "format" or "format/borders"');
  const apps = Array.isArray(f.app) ? f.app : [f.app];
  if (!apps.length || !apps.every(a => a === '*' || APP_IDS.includes(a))) err(`\`app\` must be one of ${APP_IDS.join(', ')} or '*'`);
  if (!f.upstream || typeof f.upstream !== 'object' || !UPSTREAM_REPOS.includes(f.upstream.repo) || !Array.isArray(f.upstream.files)) {
    err(`\`upstream\` must be {repo: ${UPSTREAM_REPOS.join('|')}, commit?, files: string[]}`);
  }
  if (!Array.isArray(f.commands)) { err('`commands` must be an array'); return errors; }
  const seen = new Set();
  f.commands.forEach((c, i) => {
    const at = `command ${c?.id ?? '#' + i}`;
    if (!c || typeof c !== 'object') { err(`${at}: not an object`); return; }
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) err(`${at}: \`id\` must look like "area.name"`);
    else if (seen.has(c.id)) err(`${at}: defined twice in this family`);
    seen.add(c.id);
    if (typeof c.label !== 'string' || !c.label.trim()) err(`${at}: \`label\` is required`);
    if (!isRisk(c.risk)) err(`${at}: \`risk\` must be read, edit, destructive or irreversible`);
    if (!isSchema(c.params) || c.params.type !== 'object') err(`${at}: \`params\` must be s.object({...})`);
    if (c.result !== undefined && !isSchema(c.result)) err(`${at}: \`result\` must be a schema`);
    if (typeof c.run !== 'function') err(`${at}: \`run\` must be a function`);
    if (c.state !== undefined && typeof c.state !== 'function') err(`${at}: \`state\` must be a function`);
    if (c.needs !== undefined && !NEEDS.includes(c.needs)) err(`${at}: \`needs\` must be model, view or worker`);
    if (c.needs === 'view' && !allowView) err(`${at}: needs:'view' commands live in src/apps/<app>/ui-commands, not core/`);
    if (c.undo !== undefined && c.undo !== 'auto' && c.undo !== 'none') err(`${at}: \`undo\` must be 'auto' or 'none'`);
    if (c.effect !== undefined && !EFFECTS.includes(c.effect)) err(`${at}: \`effect\` must be ${EFFECTS.join(', ')}`);
    if (c.scope !== undefined && !SCOPES.includes(c.scope)) err(`${at}: \`scope\` must be doc or app`);
    if (c.riskFor !== undefined && typeof c.riskFor !== 'function') err(`${at}: \`riskFor\` must be a function`);
    if ((riskRank(c.risk) >= 2 || c.riskFor) && typeof c.summary !== 'function') err(`${at}: destructive, irreversible and riskFor commands define summary(ctx, params)`);
    if (c.summary !== undefined && typeof c.summary !== 'function') err(`${at}: \`summary\` must be a function`);
    if (c.dialog !== undefined && c.dialog !== null && typeof c.dialog !== 'string') err(`${at}: \`dialog\` must be a dialog id`);
    if (c.shortcut !== undefined && c.shortcut !== null) {
      for (const {text, steps} of parseShortcut(c.shortcut)) if (!steps) err(`${at}: shortcut "${text}" does not parse`);
    }
    if (c.risk === 'edit' && c.undo === 'none' && (c.effect ?? 'content') === 'content') {
      err(`${at}: an edit with undo:'none' must declare effect 'view', 'persist' or 'prefs'`);
    }
  });
  return errors;
}

/** Declare a command family (one file per upstream module). Throws on an invalid shape. */
export function defineCommands(f) {
  const errors = validateFamily(f, {where: `family ${f?.family ?? '?'}`, allowView: true});
  if (errors.length) throw new TypeError(errors.join('\n'));
  return Object.freeze({...f, commands: Object.freeze(f.commands.map(c => Object.freeze(normalizeCommand(c))))});
}
