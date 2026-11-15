// The person's ribbon and Quick Access Toolbar layout (Customize Ribbon), saved in prefs.ribbon.
// Translated from wordcraft crates/engine/src/ribbon.rs (RibbonLayout) at
// aadb077e072b7de05f724e359d8db82e151f125c. Wordcraft's built-in TABS, CONTEXTUAL_TABS and
// DEFAULT_QAT become per-app inputs (`info`: {tabs, contextualTabs, qat}) generated from each
// app's spec. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Built-in groups aren't editable: a built-in tab only gains custom groups after its own. Reading
// a saved layout never fails: junk, duplicates and commands this version doesn't have are dropped.

const MAX_TABS = 64;
const MAX_GROUPS = 64;
const MAX_COMMANDS = 200;
const MAX_NAME = 64;
const MAX_ID = 128;

const isControl = c => /[\u0000-\u001f\u007f-\u009f]/.test(c);
/** A name the person typed: trimmed, without control characters, at most 64 characters. */
export function cleanName(s) {
  if (typeof s !== 'string') return null;
  const out = [...s.trim()].filter(c => !isControl(c)).slice(0, MAX_NAME).join('').trim();
  return out || null;
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

export class LayoutError extends Error {}
const fail = m => { throw new LayoutError(m); };

/** `base`, or `base 2`, `base 3`… whichever `taken` doesn't have yet. */
function unique(base, taken) {
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken(`${base} ${n}`)) return `${base} ${n}`;
  return base;
}

/** Move the item at `i` by `by` places (clamped). Returns its new index. */
function shift(v, i, by) {
  const last = Math.max(0, v.length - 1);
  const to = Math.min(last, Math.max(0, i + by));
  const [item] = v.splice(i, 1);
  v.splice(to, 0, item);
  return to;
}

const builtInTabs = info => info.tabs.filter(t => !same(t, 'File'));
const defaultTabs = info => builtInTabs(info).map(name => ({name, custom: false, hidden: false, groups: []}));
const reserved = (info, name) => [...info.tabs, 'File', ...info.contextualTabs].some(t => same(t, name));
const eqTabs = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class RibbonLayout {
  /** @param {{tabs: string[], contextualTabs: string[], qat: string[]}} info */
  constructor(info, {tabs = [], qat = null} = {}) {
    this.info = {tabs: info?.tabs ?? [], contextualTabs: info?.contextualTabs ?? [], qat: info?.qat ?? []};
    /** Every tab but File, in order, once customized; empty for the default ribbon. */
    this.tabsList = tabs;
    /** The QAT's commands; null for the defaults. */
    this.qatList = qat;
  }

  /** Read a saved layout, keeping only well-formed entries (never fails). */
  static fromValue(info, v) {
    const out = new RibbonLayout(info);
    const tabs = Array.isArray(v?.tabs) ? v.tabs.slice(0, MAX_TABS) : [];
    for (const t of tabs) {
      const name = cleanName(t?.name);
      if (!name) continue;
      const groups = [];
      for (const g of (Array.isArray(t.groups) ? t.groups : []).slice(0, MAX_GROUPS)) {
        const gname = cleanName(g?.name);
        if (!gname || groups.some(x => same(x.name, gname))) continue;
        const commands = [];
        for (const id of (Array.isArray(g.commands) ? g.commands : []).slice(0, MAX_COMMANDS)) {
          if (typeof id === 'string' && id && id.length <= MAX_ID && !commands.includes(id)) commands.push(id);
        }
        groups.push({name: gname, commands});
      }
      out.tabsList.push({name, custom: t.custom === true, hidden: t.hidden === true, groups});
    }
    if (Array.isArray(v?.qat)) {
      const ids = [];
      for (const id of v.qat.slice(0, MAX_COMMANDS)) if (typeof id === 'string' && id && id.length <= MAX_ID && !ids.includes(id)) ids.push(id);
      out.qatList = ids;
    }
    out.normalize();
    return out;
  }

  /** Built-in tabs once each (missing ones back in place), custom tabs unique and unreserved; default stored as empty. */
  normalize() {
    if (!this.tabsList.length) return;
    const builtIn = builtInTabs(this.info);
    const tabs = [];
    for (const t of this.tabsList) {
      const ok = t.custom ? !reserved(this.info, t.name) : builtIn.includes(t.name);
      if (ok && !tabs.some(x => same(x.name, t.name))) tabs.push(t);
    }
    builtIn.forEach((name, i) => {
      if (tabs.some(t => !t.custom && t.name === name)) return;
      let at = 0;
      for (let k = i - 1; k >= 0; k--) {
        const p = tabs.findIndex(t => !t.custom && t.name === builtIn[k]);
        if (p >= 0) { at = p + 1; break; }
      }
      tabs.splice(at, 0, {name, custom: false, hidden: false, groups: []});
    });
    this.tabsList = eqTabs(tabs, defaultTabs(this.info)) ? [] : tabs;
  }

  /** The tabs in order (File excluded), customized or not. */
  tabs() { return this.tabsList.length ? this.tabsList : defaultTabs(this.info); }
  ribbonIsDefault() { return !this.tabsList.length; }
  qat() { return this.qatList ?? [...this.info.qat]; }

  /** Drop commands that don't exist (saved by another version, or junk). */
  retainKnown(has) {
    for (const t of this.tabsList) for (const g of t.groups) g.commands = g.commands.filter(has);
    if (this.qatList) this.qatList = this.qatList.filter(has);
  }

  edit(f) {
    const tabs = structuredClone(this.tabs());
    const r = f(tabs);
    this.tabsList = tabs;
    this.normalize();
    return r;
  }
  static tabIndex(tabs, name) {
    const i = tabs.findIndex(t => t.name === name);
    return i >= 0 ? i : fail(`no tab \`${name}\``);
  }
  static groupIndex(tab, name) {
    const i = tab.groups.findIndex(g => g.name === name);
    return i >= 0 ? i : fail(`tab \`${tab.name}\` has no custom group \`${name}\``);
  }

  setHidden(tab, hidden) { this.edit(tabs => { tabs[RibbonLayout.tabIndex(tabs, tab)].hidden = hidden; }); }

  newTab(name, after) {
    const n = name === undefined || name === null ? 'New Tab' : cleanName(name) ?? fail('a tab needs a name');
    return this.edit(tabs => {
      if (tabs.length >= MAX_TABS) fail('too many tabs');
      const unique_ = unique(n, x => reserved(this.info, x) || tabs.some(t => same(t.name, x)));
      const at = after ? RibbonLayout.tabIndex(tabs, after) + 1 : tabs.length;
      tabs.splice(at, 0, {name: unique_, custom: true, hidden: false, groups: [{name: 'New Group', commands: []}]});
      return unique_;
    });
  }

  newGroup(tab, name) {
    const n = name === undefined || name === null ? 'New Group' : cleanName(name) ?? fail('a group needs a name');
    return this.edit(tabs => {
      const t = tabs[RibbonLayout.tabIndex(tabs, tab)];
      if (t.groups.length >= MAX_GROUPS) fail('too many groups on this tab');
      const u = unique(n, x => t.groups.some(g => same(g.name, x)));
      t.groups.push({name: u, commands: []});
      return u;
    });
  }

  add(has, tab, group, id, after) {
    if (!has(id)) fail(`unknown command \`${id}\``);
    return this.edit(tabs => {
      const t = tabs[RibbonLayout.tabIndex(tabs, tab)];
      const g = t.groups[RibbonLayout.groupIndex(t, group)];
      if (g.commands.includes(id)) return false;
      if (g.commands.length >= MAX_COMMANDS) fail('too many commands in this group');
      const p = after ? g.commands.indexOf(after) : -1;
      g.commands.splice(p >= 0 ? p + 1 : g.commands.length, 0, id);
      return true;
    });
  }

  remove(tab, group, command) {
    this.edit(tabs => {
      const i = RibbonLayout.tabIndex(tabs, tab);
      if (group === undefined || group === null) {
        if (!tabs[i].custom) fail(`\`${tab}\` is a built-in tab: hide it instead`);
        tabs.splice(i, 1);
        return;
      }
      const t = tabs[i];
      const j = RibbonLayout.groupIndex(t, group);
      if (command === undefined || command === null) { t.groups.splice(j, 1); return; }
      const g = t.groups[j];
      const k = g.commands.indexOf(command);
      if (k < 0) fail(`\`${group}\` doesn't have \`${command}\``);
      g.commands.splice(k, 1);
    });
  }

  rename(tab, group, to) {
    const name = cleanName(to) ?? fail('the new name is empty');
    return this.edit(tabs => {
      const i = RibbonLayout.tabIndex(tabs, tab);
      if (group === undefined || group === null) {
        if (!tabs[i].custom) fail(`\`${tab}\` is a built-in tab and keeps its name`);
        if (reserved(this.info, name) || tabs.some((t, k) => k !== i && same(t.name, name))) fail(`there is already a tab named \`${name}\``);
        tabs[i].name = name;
      } else {
        const t = tabs[i];
        const j = RibbonLayout.groupIndex(t, group);
        if (t.groups.some((g, k) => k !== j && same(g.name, name))) fail(`\`${tab}\` already has a group named \`${name}\``);
        t.groups[j].name = name;
      }
      return name;
    });
  }

  moveBy(tab, group, command, by) {
    this.edit(tabs => {
      const i = RibbonLayout.tabIndex(tabs, tab);
      if (group === undefined || group === null) { shift(tabs, i, by); return; }
      const t = tabs[i];
      const j = RibbonLayout.groupIndex(t, group);
      if (command === undefined || command === null) { shift(t.groups, j, by); return; }
      const g = t.groups[j];
      const k = g.commands.indexOf(command);
      if (k < 0) fail(`\`${group}\` doesn't have \`${command}\``);
      shift(g.commands, k, by);
    });
  }

  resetRibbon() { this.tabsList = []; }
  resetQat() { this.qatList = null; }

  qatAdd(has, id, after) {
    if (!has(id)) fail(`unknown command \`${id}\``);
    const q = this.qat();
    if (q.includes(id)) return false;
    if (q.length >= MAX_COMMANDS) fail('the Quick Access Toolbar is full');
    const p = after ? q.indexOf(after) : -1;
    q.splice(p >= 0 ? p + 1 : q.length, 0, id);
    this.qatList = q;
    return true;
  }
  qatRemove(id) {
    const q = this.qat();
    const i = q.indexOf(id);
    if (i < 0) return false;
    q.splice(i, 1);
    this.qatList = q;
    return true;
  }
  qatMove(id, by) {
    const q = this.qat();
    const i = q.indexOf(id);
    if (i < 0) fail(`\`${id}\` isn't on the Quick Access Toolbar`);
    shift(q, i, by);
    this.qatList = q;
  }

  /** What prefs.ribbon stores (empty fields omitted, as upstream serializes). */
  toValue() {
    const out = {};
    if (this.tabsList.length) {
      out.tabs = this.tabsList.map(t => ({name: t.name, ...(t.custom ? {custom: true} : {}), ...(t.hidden ? {hidden: true} : {}),
        ...(t.groups.length ? {groups: t.groups.map(g => ({name: g.name, commands: [...g.commands]}))} : {})}));
    }
    if (this.qatList) out.qat = [...this.qatList];
    return out;
  }
  /** The tabs as the command reports them (empty fields omitted). */
  tabsValue() {
    return this.tabs().map(t => ({name: t.name, ...(t.custom ? {custom: true} : {}), ...(t.hidden ? {hidden: true} : {}),
      ...(t.groups.length ? {groups: t.groups.map(g => ({name: g.name, commands: [...g.commands]}))} : {})}));
  }
}
