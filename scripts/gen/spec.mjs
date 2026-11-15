// Spec normalizer (docs/architecture.md section 7): docs/spec/<app>.json -> the RibbonModel/SpecModel
// the shell renders, with layout overlays (7.3), patches (7.4) and validation (7.5).
//
// The five specs were written by different agents, so shapes vary: controls carry `args` or
// `params`; children live in `items`, `submenu` or `menu`; launchers are `launcher`,
// `dialogLauncher` or a `kind:"launcher"` control; contextual tabs say `contextFor`, `when`,
// `visibleWhen` or `tabSet`; the QAT is an array, an object with `defaults`, or a title-bar group;
// dialogs name their submit command `command` or `applies`; status bars are strings or objects.
// Every variation is normalized; anything unexpected is reported as a warning, never a crash.

import path from 'node:path';
import {kebab, exists, readJson, walk, mergePatch, SPEC_STEM, SPEC_DIRS, rel} from './util.mjs';
import {parseShortcut, formatShortcut} from '../../core/kernel/command.mjs';

export const SPEC_MODEL_VERSION = 1;

const RENDER_TYPE = Object.freeze({
  button: 'button', toggle: 'toggle', checkbox: 'toggle', split: 'split', dropdown: 'menu', menu: 'menu', submenu: 'menu',
  gallery: 'gallery', combo: 'combo', color: 'color', spinner: 'spinner', launcher: 'launcher', label: 'label',
  palette: 'palette', moreColors: 'button', group: 'group', text: 'combo', textbox: 'combo', slider: 'spinner',
});
const FIELD_KINDS = new Set(['number', 'select', 'checkbox', 'color', 'text', 'radio', 'list', 'preview', 'button']);
const LAYOUT_PRIMITIVES = new Set(['large', 'medium', 'small', 'stack', 'rows', 'gallery', 'separator']);
const COMMAND_IN_TEXT = /\(([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)(?:\s*\{[^}]*\})?\)\s*$/;
const COMMAND_ID = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)+$/;

/** Command id named in prose: "Cut (edit.cut)" -> "edit.cut". */
export const commandInText = text => (typeof text === 'string' ? COMMAND_IN_TEXT.exec(text)?.[1] ?? null : null);
const isSeparator = x => x === '-' || x === '—' || x === '–' || (x && typeof x === 'object' && x.separator === true && !x.label);
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = x => (typeof x === 'string' && x.trim() ? x : null);

/**
 * Family (the command module stem) a spec command belongs to:
 *   crates/engine/src/cmd/<m>.rs, crates/engine/src/cmd/<m>/<file>.rs -> <m>
 *   core/slate-<m>.mjs                                               -> <m>
 *   anything else (ui layers, catalogues, null)                      -> the id's first segment
 */
export function familyOf(command) {
  const ref = String(command?.sourceRef ?? '');
  const m = /crates\/engine\/src\/cmd\/([A-Za-z0-9_]+)(?:\.rs|\/)/.exec(ref) || /core\/slate-([A-Za-z0-9_-]+)\.mjs/.exec(ref);
  if (m) return {family: m[1], fromSource: true};
  const prefix = String(command?.id ?? '').split('.')[0].replace(/[^A-Za-z0-9_-]/g, '_').toLowerCase() || 'misc';
  return {family: prefix, fromSource: false};
}

function summarize(report, where, label, items, limit = 6) {
  if (!items.length) return;
  const shown = items.slice(0, limit).join(', ');
  report.warn(where, `${label} (${items.length}): ${shown}${items.length > limit ? ', …' : ''}`);
}

// ---------------------------------------------------------------------------------------------
// Normalization

function normOptions(options) {
  if (!Array.isArray(options)) return undefined;
  return options.map(o => (isObj(o) ? {value: o.value ?? o.id ?? o.label, label: String(o.label ?? o.value ?? o.id ?? ''), ...(typeof o.icon === 'string' ? {icon: o.icon} : {})}
    : {value: o, label: String(o)}));
}

class Normalizer {
  constructor(app, raw, report, where) {
    this.app = app;
    this.raw = raw;
    this.report = report;
    this.where = where;
    this.ids = new Set();
    this.unknownKinds = new Map();
    this.dupIds = [];
    this.rawOf = new WeakMap();
    this.catalogue = new Map();
  }

  uniqueId(base) {
    if (!this.ids.has(base)) { this.ids.add(base); return base; }
    let n = 2;
    while (this.ids.has(`${base}-${n}`)) n++;
    this.ids.add(`${base}-${n}`);
    return `${base}-${n}`;
  }

  type(kind, raw) {
    if (raw?.style === 'checkbox') return 'toggle';
    if (RENDER_TYPE[kind]) return RENDER_TYPE[kind];
    this.unknownKinds.set(kind, (this.unknownKinds.get(kind) || 0) + 1);
    return 'button';
  }

  /** A ribbon/QAT/menu control. `forcedId` keeps an id when a patch re-normalizes the control. */
  control(raw, parentId, forcedId) {
    if (isSeparator(raw)) return {separator: true};
    if (typeof raw === 'string') {
      const id = this.uniqueId(`${parentId}.${kebab(raw)}`);
      return {id, label: raw.replace(COMMAND_IN_TEXT, '').trim() || raw, kind: 'button', type: 'button', command: commandInText(raw),
        args: null, shortcut: null, dialog: null, icon: null, source: null, sourceRef: null};
    }
    if (!isObj(raw)) return {separator: true};
    if (raw.header !== undefined && raw.label === undefined && raw.command === undefined) return {header: String(raw.header)};
    const label = str(raw.label) ?? str(raw.submenu && typeof raw.submenu === 'string' ? raw.submenu : null) ?? str(raw.command) ?? str(raw.id) ?? 'Item';
    let id = forcedId;
    if (!id) {
      if (str(raw.id)) {
        if (this.ids.has(raw.id)) this.dupIds.push(raw.id);
        id = this.uniqueId(raw.id);
      } else {
        id = this.uniqueId(`${parentId}.${kebab(label)}`);
      }
    }
    const children = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.submenu) ? raw.submenu : Array.isArray(raw.menu) ? raw.menu : null;
    const kind = str(raw.kind) ?? (children ? 'dropdown' : 'button');
    const args = isObj(raw.args) ? raw.args : isObj(raw.params) ? raw.params : null;
    const out = {
      id, label, kind, type: this.type(kind, raw),
      command: str(raw.command), args, shortcut: str(raw.shortcut), dialog: str(raw.dialog), icon: str(raw.icon),
      source: str(raw.source), sourceRef: str(raw.sourceRef),
    };
    for (const k of ['size', 'row', 'style', 'note', 'keytip', 'state', 'availability', 'visibleWhen', 'section', 'checkable', 'registered', 'commandStatus', 'status',
      'thumb', 'dynamic', 'tiles', 'valueLabel', 'checkedLabel', 'step', 'scale', 'decimals', 'noLabel', 'labelled']) {
      if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
    }
    if (raw.options !== undefined) out.options = normOptions(raw.options);
    if (children) out.items = children.map(c => this.control(c, id));
    this.rawOf.set(out, raw);
    return out;
  }

  launcher(raw) {
    if (!isObj(raw)) return null;
    const out = {dialog: str(raw.dialog), pane: str(raw.pane), command: str(raw.command), args: isObj(raw.args) ? raw.args : isObj(raw.params) ? raw.params : null, label: str(raw.label)};
    if (!out.pane && isObj(out.args) && typeof out.args.pane === 'string') out.pane = out.args.pane;
    return out.dialog || out.pane || out.command ? out : null;
  }

  tabs() {
    const tabs = [];
    const tabIds = new Set();
    const ribbon = Array.isArray(this.raw.ribbon) ? this.raw.ribbon : [];
    if (!Array.isArray(this.raw.ribbon)) this.report.warn(this.where, 'spec has no ribbon[] array');
    for (const rt of ribbon) {
      if (!isObj(rt)) continue;
      const label = str(rt.tab) ?? str(rt.label) ?? 'Tab';
      let id = kebab(label);
      if (tabIds.has(id)) id = `${id}-${kebab(rt.contextFor ?? rt.tabSet ?? rt.surface ?? 'contextual')}`;
      while (tabIds.has(id)) id += '-2';
      tabIds.add(id);
      const contextual = rt.contextual === true;
      const flagText = str(rt.contextFor) ?? str(rt.when) ?? str(rt.visibleWhen) ?? str(rt.tabSet);
      const contextFor = contextual ? (str(rt.contextFor) && /^[A-Za-z0-9_-]+$/.test(rt.contextFor) ? rt.contextFor : id) : null;
      const tab = {id, label, contextual, contextFor, contextNote: contextual && flagText !== contextFor ? flagText : null,
        keytip: str(rt.keytip), surface: str(rt.surface), mode: str(rt.mode), source: str(rt.source), sourceRef: str(rt.sourceRef),
        layoutSource: 'default', groups: []};
      const groupIds = new Set();
      for (const rg of Array.isArray(rt.groups) ? rt.groups : []) {
        if (!isObj(rg)) continue;
        const glabel = str(rg.group) ?? str(rg.label) ?? 'Group';
        let gid = str(rg.id) && /^[A-Za-z0-9_-]+$/.test(rg.id) ? rg.id : kebab(glabel);
        while (groupIds.has(gid)) gid += '-2';
        groupIds.add(gid);
        const group = {id: gid, label: glabel, launcher: this.launcher(rg.launcher ?? rg.dialogLauncher), keytip: str(rg.keytip),
          collapseOrder: null, collapsedIcon: null, layout: [], widths: {}, controls: []};
        for (const k of ['source', 'sourceRef', 'when', 'visibleWhen', 'category', 'icon', 'availability', 'badge']) if (rg[k] !== undefined && rg[k] !== null) group[k] = rg[k];
        for (const rc of Array.isArray(rg.controls) ? rg.controls : []) {
          if (isObj(rc) && rc.kind === 'launcher') {
            group.launcher = group.launcher || this.launcher({...rc, label: rc.label});
            continue;
          }
          group.controls.push(this.control(rc, `${id}.${gid}`));
        }
        group.layout = defaultLayout(group.controls);
        tab.groups.push(group);
      }
      tabs.push(tab);
    }
    return tabs;
  }

  qat(tabs) {
    const raw = this.raw;
    const byCommand = new Map();
    walkControls(tabs, c => { if (c.command && c.icon && !byCommand.has(c.command)) byCommand.set(c.command, c.icon); });
    const fromCommands = list => list.filter(x => typeof x === 'string').map(cmd => ({
      id: this.uniqueId(`qat.${kebab(cmd)}`), label: this.catalogue.get(cmd)?.label ?? cmd, kind: 'button', type: 'button',
      command: cmd, args: null, shortcut: this.catalogue.get(cmd)?.shortcut ?? null, dialog: null, icon: byCommand.get(cmd) ?? null, source: null, sourceRef: null}));
    if (Array.isArray(raw.quickAccessToolbar)) return {source: 'quickAccessToolbar', controls: raw.quickAccessToolbar.map(c => this.control(c, 'qat'))};
    if (isObj(raw.quickAccessToolbar) && Array.isArray(raw.quickAccessToolbar.defaults)) {
      const available = Array.isArray(raw.quickAccessToolbar.available) ? raw.quickAccessToolbar.available : [];
      const controls = raw.quickAccessToolbar.defaults.map(cmd => {
        const a = available.find(x => x?.command === cmd);
        return a ? {...this.control({...a, kind: a.kind ?? 'button'}, 'qat'), icon: a.icon ?? byCommand.get(cmd) ?? null}
          : fromCommands([cmd])[0];
      });
      return {source: 'quickAccessToolbar.defaults', controls, available: available.map(a => a?.command).filter(Boolean)};
    }
    const tb = Array.isArray(raw.titleBar) ? raw.titleBar.find(x => isObj(x) && Array.isArray(x.defaults)) : null;
    if (tb) return {source: 'titleBar', controls: fromCommands(tb.defaults)};
    const conv = raw.conventions?.quickAccessDefault;
    if (Array.isArray(conv)) return {source: 'conventions.quickAccessDefault', controls: fromCommands(conv)};
    return {source: null, controls: []};
  }

  backstageNode(raw, parent) {
    if (typeof raw === 'string') return {id: `${parent}.${kebab(raw)}`, label: raw.replace(COMMAND_IN_TEXT, '').trim() || raw, kind: 'item', command: commandInText(raw)};
    if (!isObj(raw)) return null;
    const label = str(raw.label) ?? str(raw.id) ?? 'Item';
    const node = {id: str(raw.id) ?? `${parent}.${kebab(label)}`, label, kind: str(raw.kind) ?? (raw.command ? 'action' : 'section'),
      command: str(raw.command), dialog: str(raw.dialog), args: isObj(raw.params) ? raw.params : isObj(raw.args) ? raw.args : null};
    for (const k of ['shortcut', 'icon', 'sourceRef', 'source', 'note', 'position']) if (raw[k] !== undefined && raw[k] !== null) node[k] = raw[k];
    const kids = [raw.children, raw.sections, raw.contents, raw.items].find(Array.isArray);
    if (kids) node.children = kids.map(k => this.backstageNode(k, node.id)).filter(Boolean);
    return node;
  }

  backstage() {
    const list = Array.isArray(this.raw.backstage) ? this.raw.backstage : [];
    return list.map(b => {
      const n = this.backstageNode(b, 'file');
      if (n) n.kind = b?.kind === 'action' || b?.kind === 'command' ? 'action' : 'page';
      return n;
    }).filter(Boolean);
  }

  field(raw, dialogId) {
    if (!isObj(raw)) return null;
    const kind = str(raw.kind) ?? 'text';
    if (!FIELD_KINDS.has(kind)) this.fieldKinds.add(kind);
    const f = {id: str(raw.id) ?? kebab(raw.label ?? 'field'), label: String(raw.label ?? ''), kind, options: normOptions(raw.options) ?? []};
    for (const k of ['min', 'max', 'step', 'unit', 'default', 'dialog', 'input', 'multiline', 'readOnly', 'command', 'param', 'visibleWhen', 'enabledWhen', 'note', 'refPicker', 'hint', 'source', 'navigation', 'itemsFrom', 'filterBy', 'empty', 'height', 'swatch']) {
      if (raw[k] !== undefined && raw[k] !== null) f[k] = raw[k];
    }
    if (raw.accept !== undefined) f.accept = Array.isArray(raw.accept) ? raw.accept : String(raw.accept).split(/\s*,\s*/);
    if (raw.masked || raw.password || raw.secret) f.masked = true;
    void dialogId;
    return f;
  }

  dialog(raw, forcedId) {
    const id = forcedId ?? str(raw.id);
    const tabs = (Array.isArray(raw.tabs) ? raw.tabs : []).map(t => ({
      name: String(t?.name ?? ''), fields: (Array.isArray(t?.fields) ? t.fields : []).map(f => this.field(f, id)).filter(Boolean)}));
    const labels = Array.isArray(raw.buttons) ? raw.buttons.filter(b => typeof b === 'string') : ['OK', 'Cancel'];
    const hasOk = labels.some(l => /^ok$/i.test(l));
    let primaryGiven = hasOk;
    const allFields = tabs.flatMap(t => t.fields);
    const buttons = labels.map(label => {
      const l = label.replace(/[.…]+$/, '').trim();
      let role = /^ok$/i.test(l) ? 'ok' : /^(cancel|close)$/i.test(l) ? 'cancel' : /^apply$/i.test(l) ? 'apply' : /^help$/i.test(l) ? 'help' : 'other';
      // No OK button: the first affirmative one ("Insert", "Save", "Rename") submits; "Don't Save" never does.
      if (role === 'other' && !primaryGiven && !/^(don['’]?t|do not|no|discard|skip)\b/i.test(l)) { role = 'ok'; primaryGiven = true; }
      const field = allFields.find(f => f.kind === 'button' && f.label.replace(/[.…:]+$/, '').trim().toLowerCase() === l.toLowerCase());
      return {id: kebab(l), label, role, command: field?.command ?? null};
    });
    const presentation = str(raw.presentation) ?? (raw.workspace ? 'full-window' : 'modal');
    const d = {id, title: String(raw.title ?? id), command: str(raw.command) ?? str(raw.applies), presentation, tabs, buttons,
      relatedCommands: Array.isArray(raw.relatedCommands) ? raw.relatedCommands.filter(x => typeof x === 'string') : [], sourceRef: str(raw.sourceRef)};
    for (const k of ['modeless', 'system', 'note', 'source', 'defaults', 'openedBy']) if (raw[k] !== undefined && raw[k] !== null) d[k] = raw[k];
    this.rawOf.set(d, raw);
    return d;
  }

  dialogs() {
    const out = {};
    this.fieldKinds = new Set();
    const dups = [];
    for (const raw of Array.isArray(this.raw.dialogs) ? this.raw.dialogs : []) {
      if (!isObj(raw) || !str(raw.id)) { this.report.warn(this.where, 'a dialog without an id was skipped'); continue; }
      if (out[raw.id]) { dups.push(raw.id); continue; }
      out[raw.id] = this.dialog(raw);
    }
    summarize(this.report, this.where, 'duplicate dialog ids (first kept)', dups);
    if (this.fieldKinds.size) this.report.note(this.where, `dialog field kinds beyond the core set: ${[...this.fieldKinds].sort().join(', ')}`);
    return out;
  }

  command(raw, forcedId) {
    const id = forcedId ?? raw.id;
    const {family, fromSource} = familyOf({...raw, id});
    const c = {id, label: str(raw.label), summary: str(raw.summary), args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      paramsDoc: str(raw.paramsDoc) ?? str(typeof raw.params === 'string' ? raw.params : null), sourceRef: str(raw.sourceRef),
      shortcut: str(raw.shortcut), dialog: str(raw.dialog) ?? str(raw.opensDialogWithoutArgs), family, familyFromSource: fromSource};
    for (const k of ['layer', 'mode', 'undoable', 'location', 'menu', 'implRef', 'enabledWhen', 'uiOnly', 'frontendOnly', 'availability', 'needs']) {
      if (raw[k] !== undefined && raw[k] !== null) c[k] = raw[k];
    }
    this.rawOf.set(c, raw);
    return c;
  }

  commands() {
    const out = {};
    const dups = [], bad = [];
    for (const raw of Array.isArray(this.raw.commands) ? this.raw.commands : []) {
      if (!isObj(raw) || typeof raw.id !== 'string') continue;
      if (!COMMAND_ID.test(raw.id)) bad.push(raw.id);
      if (out[raw.id]) { dups.push(raw.id); continue; }
      out[raw.id] = this.command(raw);
      this.catalogue.set(raw.id, out[raw.id]);
    }
    summarize(this.report, this.where, 'duplicate command ids (first kept)', dups);
    summarize(this.report, this.where, 'command ids outside the area.name shape', bad);
    return out;
  }

  menuItems(raw, commands, parent) {
    const items = [];
    (Array.isArray(raw) ? raw : []).forEach((it, i) => {
      if (isSeparator(it)) { items.push({separator: true}); return; }
      if (typeof it === 'string') {
        let command = commandInText(it);
        let dialog = null;
        if (!command && Array.isArray(commands) && typeof commands[i] === 'string') command = commands[i];
        if (!command && isObj(commands) && typeof commands[it] === 'string') command = commands[it];
        if (command && command.startsWith('dialog.')) { dialog = command; command = null; }
        items.push({id: `${parent}.${kebab(it)}-${i}`, label: it.replace(COMMAND_IN_TEXT, '').trim() || it, command, dialog});
        return;
      }
      if (isObj(it)) {
        const label = str(it.label) ?? str(it.submenu) ?? str(it.command) ?? 'Item';
        const node = {id: `${parent}.${kebab(label)}-${i}`, label, command: str(it.command), dialog: str(it.dialog),
          args: isObj(it.args) ? it.args : isObj(it.params) ? it.params : null};
        const kids = Array.isArray(it.items) ? it.items : Array.isArray(it.submenu) ? it.submenu : null;
        if (kids) node.items = this.menuItems(kids, null, node.id);
        if (str(it.kind)) node.kind = it.kind;
        if (str(it.icon)) node.icon = it.icon;
        // A list the command's state fills (a misspelt word's suggestions), set in bold: one entry each in the right-click menu.
        if (it.dynamic === true) node.dynamic = true;
        if (str(it.style)) node.style = it.style;
        items.push(node);
      }
    });
    return items;
  }

  contextMenus() {
    return (Array.isArray(this.raw.contextMenus) ? this.raw.contextMenus : []).filter(isObj).map((m, i) => {
      const target = str(m.target) ?? `menu-${i}`;
      const items = this.menuItems(m.items, m.commands, `ctx.${kebab(target)}`);
      if (Array.isArray(m.officeItems)) for (const it of this.menuItems(m.officeItems, null, `ctx.${kebab(target)}.office`)) items.push({...it, office: true});
      return {target, when: str(m.when) ?? str(m.opens), sourceRef: str(m.sourceRef), items};
    });
  }

  panes() {
    return (Array.isArray(this.raw.panes) ? this.raw.panes : []).filter(isObj).map(p => {
      const out = {id: str(p.id) ?? kebab(p.label), label: String(p.label ?? p.id ?? ''), side: str(p.side) ?? str(p.dock), width: Number.isFinite(p.width) ? p.width : null,
        command: str(p.command), dialog: str(p.dialog), args: isObj(p.params) ? p.params : null, sourceRef: str(p.sourceRef)};
      for (const k of ['contents', 'commands', 'tabs', 'fields', 'note']) if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
      return out;
    });
  }

  statusBar() {
    const src = Array.isArray(this.raw.statusBarItems) && this.raw.statusBarItems.some(isObj) ? this.raw.statusBarItems : this.raw.statusBar;
    const seen = new Set();
    return (Array.isArray(src) ? src : []).map(x => {
      const item = typeof x === 'string' ? {id: kebab(x).slice(0, 48), label: x, command: commandInText(x)}
        : isObj(x) ? {id: str(x.id) ?? kebab(x.label).slice(0, 48), label: String(x.label ?? x.id ?? ''), command: str(x.command) ?? commandInText(x.click)}
          : null;
      if (!item) return null;
      if (isObj(x)) for (const k of ['click', 'side', 'kind', 'when', 'sourceRef', 'note']) if (x[k] !== undefined && x[k] !== null) item[k] = x[k];
      while (seen.has(item.id)) item.id += '-2';
      seen.add(item.id);
      return item;
    }).filter(Boolean);
  }

  shortcuts() {
    const out = [], unparseable = [];
    let noCommand = 0;
    for (const s of Array.isArray(this.raw.shortcuts) ? this.raw.shortcuts : []) {
      if (!isObj(s) || typeof s.keys !== 'string') continue;
      const command = str(s.command);
      if (!command && !str(s.dialog)) { noCommand++; continue; }
      const parsed = parseShortcut(s.keys);
      if (parsed.some(p => !p.steps)) unparseable.push(s.keys);
      out.push({keys: s.keys, command, dialog: str(s.dialog), args: isObj(s.args) ? s.args : isObj(s.params) ? s.params : null,
        mac: str(s.mac), context: str(s.context) ?? 'app', note: str(s.note)});
    }
    if (noCommand) this.report.note(this.where, `${noCommand} shortcuts without a command were skipped`);
    summarize(this.report, this.where, 'shortcut keys that do not parse', [...new Set(unparseable)]);
    return out;
  }
}

/** Default arrangement when no overlay exists: large controls alone, the rest in stacks of three. */
export function defaultLayout(controls) {
  const layout = [];
  let stack = [];
  const flush = () => { if (stack.length) layout.push({stack}); stack = []; };
  for (const c of controls) {
    if (!c.id) continue;
    if (c.size === 'large') { flush(); layout.push({large: c.id}); continue; }
    stack.push(c.id);
    if (stack.length === 3) flush();
  }
  flush();
  return layout;
}

export function walkControls(tabs, fn) {
  const visit = (c, ctx) => { if (!c || c.separator || c.header) return; fn(c, ctx); for (const k of c.items || []) visit(k, ctx); };
  for (const tab of tabs) for (const group of tab.groups) for (const c of group.controls) visit(c, {tab, group});
}

/** Normalize one raw spec (any of the five shapes). */
export function normalizeSpec(raw, {app, report, file = `docs/spec/${SPEC_STEM[app]}.json`}) {
  const where = file;
  if (!isObj(raw)) { report.error(where, 'spec is not a JSON object'); return null; }
  const n = new Normalizer(app, raw, report, where);
  if (raw.app && raw.app !== app && raw.app !== SPEC_STEM[app]) report.warn(where, `spec says app "${raw.app}", expected ${app}`);
  const commands = n.commands();
  const tabs = n.tabs();
  const qat = n.qat(tabs);
  const model = {
    version: 1,
    app,
    specFile: file,
    product: String(raw.product ?? raw.productName ?? raw.upstreamName ?? app),
    upstream: raw.upstream === null ? null : {repo: typeof raw.upstream === 'string' ? raw.upstream : str(raw.upstream?.repo),
      commit: str(raw.upstreamCommit) ?? str(raw.upstream?.commit) ?? null},
    tabs,
    qat: qat.controls,
    qatSource: qat.source,
    qatAvailable: qat.available ?? [],
    titleBar: Array.isArray(raw.titleBar) ? raw.titleBar.filter(isObj).map(t => ({id: String(t.id ?? kebab(t.label)), label: String(t.label ?? ''), kind: str(t.kind),
      command: str(t.command), dialog: str(t.dialog)})) : [],
    backstage: n.backstage(),
    dialogs: n.dialogs(),
    commands,
    contextMenus: n.contextMenus(),
    panes: n.panes(),
    statusBar: n.statusBar(),
    shortcuts: n.shortcuts(),
    extensions: (Array.isArray(raw.arkemisExtensions) ? raw.arkemisExtensions : []).filter(isObj).map(e => ({id: String(e.id), label: String(e.label ?? e.id),
      kind: str(e.kind), command: str(e.command), existing: str(e.existing), note: str(e.note)})),
    alreadyImplemented: Array.isArray(raw.alreadyImplementedInStudio) ? raw.alreadyImplementedInStudio.length
      : isObj(raw.alreadyImplementedInStudio) ? Object.keys(raw.alreadyImplementedInStudio.controls ?? {}).length : 0,
  };
  summarize(report, where, 'duplicate control ids (renamed with a -2 suffix)', n.dupIds);
  if (n.unknownKinds.size) report.note(where, `control kinds rendered as buttons: ${[...n.unknownKinds].map(([k, c]) => `${k}×${c}`).join(', ')}`);
  Object.defineProperty(model, '_normalizer', {value: n, enumerable: false});
  return model;
}

// ---------------------------------------------------------------------------------------------
// Patches (7.4)

function indexControls(model) {
  const index = new Map();
  const visitList = (list, owner) => list.forEach((c, i) => {
    if (c && c.id) { index.set(c.id, {list, i, owner}); if (c.items) visitList(c.items, c); }
  });
  for (const tab of model.tabs) for (const group of tab.groups) visitList(group.controls, group);
  visitList(model.qat, null);
  return index;
}

/**
 * Apply docs/spec/patches/<app>/*.json in sorted filename order. Two patches touching the same
 * entry fail, naming both files.
 */
export function applyPatches(model, patches, report) {
  if (!patches.length) return;
  const n = model._normalizer;
  const touched = new Map();
  const touch = (section, key, file) => {
    const k = `${section}:${key}`;
    if (touched.has(k)) { report.error(file, `patch touches ${section} "${key}", already patched by ${touched.get(k)}`); return false; }
    touched.set(k, file);
    return true;
  };
  for (const {file, json} of patches) {
    if (!isObj(json)) { report.error(file, 'a patch is a JSON object'); continue; }
    for (const key of Object.keys(json)) {
      if (!['controls', 'dialogs', 'commands', 'insertAfter', 'tabs', 'contextMenus', 'groups', 'panes'].includes(key)) report.error(file, `unknown patch section "${key}"`);
    }
    let index = indexControls(model);
    for (const [id, patch] of Object.entries(json.controls ?? {})) {
      if (!touch('controls', id, file)) continue;
      const at = index.get(id);
      if (!at) { report.error(file, `no control "${id}" to patch`); continue; }
      const current = at.list[at.i];
      const raw = n.rawOf.get(current) ?? current;
      const merged = mergePatch(raw, patch);
      const forget = c => { if (c?.id) n.ids.delete(c.id); for (const k of c?.items || []) forget(k); };
      for (const k of current.items || []) forget(k);
      at.list[at.i] = n.control({...merged, id}, id.split('.').slice(0, -1).join('.'), id);
    }
    for (const [id, patch] of Object.entries(json.dialogs ?? {})) {
      if (!touch('dialogs', id, file)) continue;
      const current = model.dialogs[id];
      const raw = current ? n.rawOf.get(current) ?? current : {id};
      if (!current && !isObj(patch)) { report.error(file, `no dialog "${id}" to patch`); continue; }
      n.fieldKinds = new Set();
      model.dialogs[id] = n.dialog(mergePatch(raw, patch), id);
    }
    for (const [id, patch] of Object.entries(json.commands ?? {})) {
      if (!touch('commands', id, file)) continue;
      const current = model.commands[id];
      const raw = current ? n.rawOf.get(current) ?? current : {id};
      model.commands[id] = n.command(mergePatch(raw, patch), id);
    }
    // A right-click menu's items, replaced (the spec's `commands` list pairs with its items by position, which only holds when every item has one).
    for (const [target, patch] of Object.entries(json.contextMenus ?? {})) {
      if (!touch('contextMenus', target, file)) continue;
      const menu = model.contextMenus.find(x => x.target === target);
      if (!menu) { report.error(file, `no context menu "${target}" to patch`); continue; }
      if (!isObj(patch) || !Array.isArray(patch.items)) { report.error(file, `contextMenus["${target}"] needs an items array`); continue; }
      menu.items = n.menuItems(patch.items, null, `ctx.${kebab(target)}`);
    }
    for (const [id, patch] of Object.entries(json.tabs ?? {})) {
      if (!touch('tabs', id, file)) continue;
      const tab = model.tabs.find(t => t.id === id);
      if (!tab) { report.error(file, `no tab "${id}" to patch`); continue; }
      for (const [k, v] of Object.entries(patch ?? {})) {
        if (['contextFor', 'label', 'keytip', 'contextual'].includes(k)) { if (v === null) tab[k] = null; else tab[k] = v; }
        else report.error(file, `tab patches may set contextFor, label, keytip or contextual, not "${k}"`);
      }
    }
    // A group on a tab: `groups["<tab>/<group>"]` updates an existing group's label, keytip, collapseOrder or collapsedIcon, or adds one
    // (`after`: the group id it follows, else last) with its `controls` (each needs an id and is checked like a control inserted by insertAfter)
    // and an explicit `layout` (the overlay primitives; without one the default layout is used).
    for (const [key, patch] of Object.entries(json.groups ?? {})) {
      if (!touch('groups', key, file)) continue;
      const [tabId, groupId] = key.split('/');
      const tab = model.tabs.find(t => t.id === tabId);
      if (!tab || !groupId || !isObj(patch)) { report.error(file, `groups["${key}"] needs an existing tab and an object`); continue; }
      const existing = tab.groups.find(g => g.id === groupId);
      if (existing) {
        for (const k of ['label', 'keytip', 'collapsedIcon']) if (str(patch[k])) existing[k] = patch[k];
        if (Number.isFinite(patch.collapseOrder)) existing.collapseOrder = patch.collapseOrder;
        continue;
      }
      const group = {id: groupId, label: str(patch.label) ?? groupId, launcher: null, keytip: str(patch.keytip),
        collapseOrder: Number.isFinite(patch.collapseOrder) ? patch.collapseOrder : null, collapsedIcon: str(patch.collapsedIcon), layout: [], widths: {}, controls: []};
      const known = indexControls(model);
      for (const rc of Array.isArray(patch.controls) ? patch.controls : []) {
        if (!isObj(rc) || !str(rc.id)) { report.error(file, `controls of group "${key}" need an id`); continue; }
        if (known.has(rc.id)) { report.error(file, `control id "${rc.id}" already exists`); continue; }
        n.ids.add(rc.id);
        group.controls.push(n.control(rc, `${tabId}.${groupId}`, rc.id));
      }
      if (Array.isArray(patch.layout)) {
        const ids = new Set(group.controls.filter(c => c.id).map(c => c.id));
        for (const item of patch.layout) for (const id of placedIds(item, report, file)) if (!ids.has(id)) report.error(file, `group ${key} places "${id}", which is not one of its controls`);
        group.layout = patch.layout;
      } else group.layout = defaultLayout(group.controls);
      const at = patch.after ? tab.groups.findIndex(g => g.id === patch.after) : tab.groups.length - 1;
      if (patch.after && at < 0) { report.error(file, `group ${key}: no group "${patch.after}" to follow`); continue; }
      tab.groups.splice(at + 1, 0, group);
    }
    // A task pane: `panes["<id>"]` merged into the spec's pane of that id, or added ({label, side, width, note}).
    for (const [id, patch] of Object.entries(json.panes ?? {})) {
      if (!touch('panes', id, file)) continue;
      if (!isObj(patch)) { report.error(file, `panes["${id}"] needs an object`); continue; }
      const current = model.panes.find(p => p.id === id);
      const made = {id, label: String(patch.label ?? current?.label ?? id), side: str(patch.side) ?? current?.side ?? 'right', width: Number.isFinite(patch.width) ? patch.width : current?.width ?? null,
        command: str(patch.command) ?? current?.command ?? null, dialog: current?.dialog ?? null, args: current?.args ?? null, sourceRef: str(patch.sourceRef) ?? current?.sourceRef ?? null};
      if (str(patch.note)) made.note = patch.note;
      if (current) Object.assign(current, made); else model.panes.push(made);
    }
    index = indexControls(model);
    for (const [afterId, list] of Object.entries(json.insertAfter ?? {})) {
      if (!touch('insertAfter', afterId, file)) continue;
      const at = index.get(afterId);
      if (!at) { report.error(file, `no control "${afterId}" to insert after`); continue; }
      if (!Array.isArray(list)) { report.error(file, `insertAfter["${afterId}"] must be an array`); continue; }
      const made = [];
      for (const rc of list) {
        if (!isObj(rc) || !str(rc.id)) { report.error(file, `inserted controls need an id (after ${afterId})`); continue; }
        if (index.has(rc.id)) { report.error(file, `inserted control id "${rc.id}" already exists`); continue; }
        made.push(n.control(rc, afterId, rc.id));
      }
      at.list.splice(at.i + 1, 0, ...made);
      if (at.owner && at.owner.layout && !at.owner.items) {
        // a group: keep the default layout in step (overlays place them explicitly)
        at.owner.layout = defaultLayout(at.owner.controls);
      }
      index = indexControls(model);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Layout overlays (7.3)

function placedIds(item, report, file) {
  if (!isObj(item)) { report.error(file, `layout item ${JSON.stringify(item)} is not an object`); return []; }
  const keys = Object.keys(item).filter(k => LAYOUT_PRIMITIVES.has(k));
  if (keys.length !== 1) { report.error(file, `layout item ${JSON.stringify(item)} must use exactly one of ${[...LAYOUT_PRIMITIVES].join(', ')}`); return []; }
  const k = keys[0];
  if (k === 'separator') return [];
  if (k === 'large' || k === 'medium' || k === 'small' || k === 'gallery') return typeof item[k] === 'string' ? [item[k]] : (report.error(file, `${k} takes a control id`), []);
  if (k === 'stack') {
    if (!Array.isArray(item.stack) || item.stack.length > 3) { report.error(file, 'stack takes one to three control ids'); return []; }
    // An optional column header ("Indent", "Spacing", "Gridlines"): the column then holds at most two controls.
    if (item.header !== undefined && (typeof item.header !== 'string' || !item.header.trim())) { report.error(file, 'a stack header is a non-empty string'); return []; }
    if (item.header !== undefined && item.stack.length > 2) { report.error(file, `stack "${item.header}" has a header, so it holds at most two controls`); return []; }
    return item.stack.filter(x => typeof x === 'string' && x !== '...');
  }
  if (!Array.isArray(item.rows) || item.rows.length < 1 || item.rows.length > 3 || !item.rows.every(Array.isArray)) {
    report.error(file, 'rows takes one to three arrays of control ids');
    return [];
  }
  // A row entry is a control id (an icon-only small button) or {medium: id} (a labelled button on its own line).
  const out = [];
  for (const x of item.rows.flat()) {
    if (typeof x === 'string') { if (x !== '...') out.push(x); continue; }
    if (isObj(x) && Object.keys(x).length === 1 && typeof x.medium === 'string') { out.push(x.medium); continue; }
    report.error(file, `a row entry is a control id or {"medium": id}, not ${JSON.stringify(x)}`);
  }
  return out;
}

export function applyTabOverlay(model, overlay, file, report) {
  const stem = path.basename(file, '.json');
  const tab = model.tabs.find(t => t.id === stem);
  if (!tab) { report.error(file, `no tab "${stem}" in ${model.specFile} (tabs: ${model.tabs.map(t => t.id).join(', ')})`); return; }
  if (!isObj(overlay)) { report.error(file, 'an overlay is a JSON object'); return; }
  if (overlay.tab !== undefined && overlay.tab !== stem) report.warn(file, `"tab" is "${overlay.tab}" but the file is ${stem}.json`);
  if (str(overlay.keytip)) tab.keytip = overlay.keytip;
  // Where a contextual tab sits: Word draws Outlining right after File (upstream ribbon.rs: "the Outlining tab right after File").
  if (overlay.position === 'afterFile') tab.position = 'afterFile';
  tab.layoutSource = file;
  const keytips = new Map();
  const claimKeytip = (k, who) => {
    if (!k) return;
    if (keytips.has(k)) report.error(file, `keytip "${k}" is used by ${keytips.get(k)} and ${who}`);
    else keytips.set(k, who);
  };
  const groups = isObj(overlay.groups) ? overlay.groups : {};
  for (const [gid, g] of Object.entries(groups)) {
    const group = tab.groups.find(x => x.id === gid);
    if (!group) { report.error(file, `no group "${gid}" on tab ${stem} (groups: ${tab.groups.map(x => x.id).join(', ')})`); continue; }
    if (!isObj(g)) { report.error(file, `group "${gid}" must be an object`); continue; }
    if (str(g.keytip)) { group.keytip = g.keytip; claimKeytip(g.keytip, `group ${gid}`); }
    if (g.launcher !== undefined) group.launcher = g.launcher === null ? null : {...(group.launcher ?? {}), ...g.launcher};
    if (Number.isFinite(g.collapseOrder)) group.collapseOrder = g.collapseOrder;
    if (str(g.collapsedIcon)) group.collapsedIcon = g.collapsedIcon;
    if (isObj(g.widths)) group.widths = {...g.widths};
    if (Array.isArray(g.layout)) {
      const ids = new Set(group.controls.filter(c => c.id).map(c => c.id));
      const placed = new Set();
      const layout = [];
      for (const item of g.layout) {
        const used = placedIds(item, report, file);
        let ok = true;
        for (const id of used) {
          if (!ids.has(id)) { report.error(file, `group ${gid} places "${id}", which is not a control of that group`); ok = false; }
          else if (placed.has(id)) { report.error(file, `group ${gid} places "${id}" twice`); ok = false; }
          else placed.add(id);
        }
        if (ok) {
          const clean = {...item};
          if (clean.rows) clean.rows = clean.rows.map(r => r.filter(x => x !== '...'));
          if (clean.stack) clean.stack = clean.stack.filter(x => x !== '...');
          layout.push(clean);
        }
      }
      const unplaced = [...ids].filter(id => !placed.has(id));
      for (const id of unplaced) layout.push({small: id, unplaced: true});
      group.layout = layout;
    }
  }
  if (isObj(overlay.keytips)) {
    const all = new Map();
    walkControls([tab], c => all.set(c.id, c));
    for (const [id, k] of Object.entries(overlay.keytips)) {
      const c = all.get(id);
      if (!c) { report.error(file, `keytip for unknown control "${id}"`); continue; }
      c.keytip = k;
      claimKeytip(k, id);
    }
  }
  if (isObj(overlay.extensions)) tab.extensions = overlay.extensions;
}

export function applyDialogOverlay(model, overlay, file, report) {
  const stem = path.basename(file, '.json');
  const id = model.dialogs[stem] ? stem : model.dialogs[`dialog.${stem}`] ? `dialog.${stem}` : null;
  if (!id) { report.error(file, `no dialog "${stem}" (or dialog.${stem}) in ${model.specFile}`); return; }
  if (!isObj(overlay)) { report.error(file, 'a dialog overlay is a JSON object'); return; }
  const dialog = model.dialogs[id];
  const fieldIds = new Set(dialog.tabs.flatMap(t => t.fields.map(f => f.id)));
  const order = overlay.fieldOrder;
  if (order !== undefined) {
    const lists = Array.isArray(order) ? [order] : isObj(order) ? Object.values(order) : null;
    if (!lists) report.error(file, 'fieldOrder is an array of field ids, or an object of tab name -> field ids');
    else for (const list of lists) for (const f of Array.isArray(list) ? list : []) if (!fieldIds.has(f)) report.error(file, `fieldOrder names unknown field "${f}"`);
  }
  for (const s of Array.isArray(overlay.sections) ? overlay.sections : []) {
    for (const f of Array.isArray(s?.fields) ? s.fields : []) if (!fieldIds.has(f)) report.error(file, `section "${s.label ?? s.id ?? '?'}" names unknown field "${f}"`);
  }
  dialog.layout = overlay;
}

// ---------------------------------------------------------------------------------------------
// Loading

/** Overlay and patch files for an app, sorted (docs/spec/layout/<dir>/..., docs/spec/patches/<dir>/...). */
export function specInputs(root, app) {
  const tabs = [], dialogs = [], patches = [];
  for (const dir of SPEC_DIRS[app]) {
    const layoutDir = path.join(root, 'docs/spec/layout', dir);
    for (const f of walk(layoutDir, n => n.endsWith('.json'))) {
      const r = rel(layoutDir, f);
      if (!r.includes('/')) tabs.push(f);
      else if (r.startsWith('dialogs/') && r.split('/').length === 2) dialogs.push(f);
    }
    patches.push(...walk(path.join(root, 'docs/spec/patches', dir), n => n.endsWith('.json')).filter(f => !rel(path.join(root, 'docs/spec/patches', dir), f).includes('/')));
  }
  const byName = (a, b) => (path.basename(a) < path.basename(b) ? -1 : path.basename(a) > path.basename(b) ? 1 : 0);
  return {tabs: tabs.sort(byName), dialogs: dialogs.sort(byName), patches: patches.sort(byName)};
}

const readOr = (file, report, root) => {
  try { return readJson(file); } catch (e) { report.error(rel(root, file), `invalid JSON: ${e.message}`); return undefined; }
};

/**
 * A menu entry whose "label" is really a spec note: a placeholder (`<SHADOW_PRESETS>`, `{size}`),
 * a list of several items in one ("A / B / C", "4, 8, 12 pt"), a style range (TableStyleLight1-21)
 * or a description ("Full Word shape library (Lines, Rectangles, ...)"). Never shown as a command.
 * A one-word label is a name, not a note (Quill's "Gallery" theme), nor is a "Name: …" entry
 * that names one ("Gallery: Helvetica Neue", the theme's fonts).
 */
const galleryNote = label => {
  const rest = String(label).trim().replace(/^[A-Za-z]+:\s+/, '');
  return /\b(gallery|picker)\b/i.test(rest) && /\s/.test(rest);
};
export const isNoteLabel = label => /<[^>]*>|\{[^}]*\}/.test(label) || /\bvariants?\b/i.test(label) || /\([^)]*,[^)]*\)/.test(label)
  || /\d+, \d+/.test(label) || /[A-Za-z]\d+-\d+\b/.test(label) || galleryNote(label) || /^(Remaining|Full) /.test(label)
  || /\S \/ \S/.test(label) || /\((when|selectable)\b/i.test(label) || label.length > 70;

// Palettes, galleries and pickers carry descriptive labels ("Theme Colors / Standard Colors"); they are controls, never notes.
export const NOT_NOTES = new Set(['palette', 'color', 'gallery', 'picker', 'grid', 'combo', 'spinner']);
function dropNoteItems(model, report) {
  const dropped = [];
  const prune = c => {
    if (!Array.isArray(c?.items)) return;
    c.items = c.items.filter(k => {
      if (k && !k.separator && !k.header && typeof k.label === 'string' && !NOT_NOTES.has(k.type ?? k.kind) && isNoteLabel(k.label)) { dropped.push(k.label); return false; }
      return true;
    });
    for (const k of c.items) prune(k);
  };
  for (const tab of model.tabs) for (const group of tab.groups) for (const c of group.controls) prune(c);
  for (const m of model.contextMenus ?? []) prune(m);
  if (dropped.length) report.note(model.specFile ?? model.app, `${dropped.length} menu entries are spec notes, not commands, and are not shown`);
}

/**
 * Give controls without an icon the one docs/spec/icon-map.json names for their label, else the
 * icon of another control that runs the same command with the same arguments.
 */
function applyIconMap(model, json) {
  const byLabel = json?.byLabel ?? {};
  // Icon ids that differ from a file only by case (smartart vs smartArt.svg) collide on Windows and macOS.
  const aliases = json?.aliases ?? {};
  walkControls(model.tabs, c => { if (c.icon && Object.hasOwn(aliases, c.icon)) c.icon = aliases[c.icon]; });
  const call = c => (c.command ? `${c.command} ${JSON.stringify(c.args ?? null)}` : null);
  const byCall = new Map();
  walkControls(model.tabs, c => { const k = call(c); if (k && c.icon && !byCall.has(k)) byCall.set(k, c.icon); });
  const menus = (model.contextMenus ?? []).map(m => ({id: `ctx:${m.target}`, groups: [{controls: m.items}]}));
  walkControls([...model.tabs, ...menus], c => {
    if (c.icon || typeof c.label !== 'string') return;
    const label = c.label.replace(/[…›]/g, '').replace(/\s+/g, ' ').trim();
    c.icon = byLabel[label] ?? byCall.get(call(c)) ?? null;
  });
}

/** Load, normalize, patch and overlay one app's spec. Returns null when the spec file is missing. */
export function buildSpecModel(root, app, report) {
  const file = path.join(root, 'docs/spec', `${SPEC_STEM[app]}.json`);
  const relFile = rel(root, file);
  if (!exists(file)) { report.warn(relFile, 'missing: the app keeps its legacy ribbon'); return null; }
  const raw = readOr(file, report, root);
  if (raw === undefined) return null;
  const model = normalizeSpec(raw, {app, report, file: relFile});
  if (!model) return null;
  const inputs = specInputs(root, app);
  const patches = inputs.patches.map(f => ({file: rel(root, f), json: readOr(f, report, root)})).filter(p => p.json !== undefined);
  applyPatches(model, patches, report);
  for (const f of inputs.tabs) { const json = readOr(f, report, root); if (json !== undefined) applyTabOverlay(model, json, rel(root, f), report); }
  for (const f of inputs.dialogs) { const json = readOr(f, report, root); if (json !== undefined) applyDialogOverlay(model, json, rel(root, f), report); }
  dropNoteItems(model, report);
  const iconMap = path.join(root, 'docs/spec/icon-map.json');
  if (exists(iconMap)) { const json = readOr(iconMap, report, root); if (json !== undefined) applyIconMap(model, json); }
  model.inputs ={patches: patches.map(p => p.file), overlays: inputs.tabs.map(f => rel(root, f)), dialogOverlays: inputs.dialogs.map(f => rel(root, f))};
  return model;
}

/** Spec-level validation (7.5) that does not need the registry. */
export function validateSpecModel(model, report, {contextFlags = null} = {}) {
  const where = model.specFile;
  const catalogue = model.commands;
  const missingCommands = new Set(), missingDialogs = new Set(), noCommand = [];
  const checkDialog = d => { if (d && !model.dialogs[d] && !/^(system|prompt)\./.test(d)) missingDialogs.add(d); };
  walkControls(model.tabs, c => {
    if (c.command && !catalogue[c.command]) missingCommands.add(c.command);
    if (!c.command && !c.dialog && !c.items?.length && c.type !== 'label' && c.type !== 'palette') noCommand.push(c.id);
    checkDialog(c.dialog);
  });
  for (const c of model.qat) if (c.command && !catalogue[c.command]) missingCommands.add(c.command);
  for (const tab of model.tabs) for (const g of tab.groups) checkDialog(g.launcher?.dialog);
  for (const c of Object.values(catalogue)) checkDialog(c.dialog);
  const submitMissing = Object.values(model.dialogs).filter(d => d.command && !catalogue[d.command]).map(d => `${d.id} -> ${d.command}`);
  summarize(report, where, 'controls whose command is not in commands[]', [...missingCommands].sort());
  summarize(report, where, 'dialogs referenced but not declared', [...missingDialogs].sort());
  summarize(report, where, 'dialog submit commands not in commands[]', submitMissing);
  if (noCommand.length) report.note(where, `${noCommand.length} controls have no command or dialog (they render only once a patch gives them one)`);
  // Shortcuts unique per context scope (spec anomalies).
  const scopes = new Map(), conflicts = [];
  for (const sc of model.shortcuts) {
    for (const entry of parseShortcut(sc.keys)) {
      if (!entry.steps) continue;
      const key = `${sc.context}|${formatShortcut(entry, 'win')}`;
      const prev = scopes.get(key);
      if (prev && prev.command !== sc.command && JSON.stringify(prev.args) === JSON.stringify(sc.args)) conflicts.push(`${sc.keys} (${prev.command} / ${sc.command})`);
      else if (!prev) scopes.set(key, sc);
    }
  }
  summarize(report, where, 'shortcuts bound to two commands in one scope', [...new Set(conflicts)]);
  // Contextual flags must exist in the app's context.mjs once the foundation provides one.
  if (Array.isArray(contextFlags)) {
    for (const tab of model.tabs) if (tab.contextual && !contextFlags.includes(tab.contextFor)) {
      report.error(where, `contextual tab ${tab.id} needs flag "${tab.contextFor}", which core/${model.app}/context.mjs does not export`);
    }
  }
  return {missingCommands: [...missingCommands].sort(), missingDialogs: [...missingDialogs].sort(), noCommand};
}

/** The shell's slim view of the model (what src/generated/<app>.spec.ts ships). */
export function shippedModel(model) {
  const {inputs, alreadyImplemented, ...rest} = model;
  void inputs; void alreadyImplemented;
  return rest;
}

/** The app info the kernel needs (tabs for Customize Ribbon, QAT defaults). */
export function appInfo(model) {
  if (!model) return null;
  // PDF's spec also lists chrome, rail and floating-toolbar surfaces: only real tabs are customizable.
  const tabs = model.tabs.filter(t => !t.contextual && (!t.surface || t.surface === 'modeTab' || t.surface === 'ribbon')).map(t => t.label);
  return {app: model.app, tabs, contextualTabs: model.tabs.filter(t => t.contextual).map(t => t.label),
    qat: model.qat.map(c => c.command).filter(Boolean)};
}
