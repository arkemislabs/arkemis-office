// The runtime ribbon model: the generated spec (src/generated/<app>.spec.ts) indexed for the shell,
// with default geometry for tabs that have no layout overlay and the pending rule of section 8.7.

import type {SpecModel, SpecTab, SpecGroup, SpecControl, SpecMenuEntry, SpecMenuItem, Args, SpecBackstageNode} from '../generated/spec-types';
import {refineDefaultLayout, type LayoutItem} from './ribbon/fit';
import {assignKeytips} from './keys/keytipTable';

export const isControl = (e: SpecMenuEntry | null | undefined): e is SpecControl => !!e && !('separator' in e) && !('header' in e) && typeof (e as SpecControl).id === 'string';

export interface RibbonTab extends Omit<SpecTab, 'groups'> { groups: RibbonGroup[] }
export interface RibbonGroup {
  id: string; key: string; tab: string; label: string; launcher: SpecGroup['launcher']; keytip: string | null;
  collapseOrder: number | null; collapsedIcon: string | null; layout: LayoutItem[]; widths: Record<string, number>; controls: SpecMenuEntry[];
}

export interface ShellModel {
  app: SpecModel['app'];
  spec: SpecModel;
  tabs: RibbonTab[];
  controls: Map<string, SpecControl>;
  /** Right-click menus by spec target, entries as controls. */
  contextMenus: {target: string; items: SpecMenuEntry[]}[];
  /** Parent control of a menu item (split/menu children), for keytips and inspection. */
  parent: Map<string, string>;
  /** Tab and group of each top-level control. */
  place: Map<string, {tab: string; group: string}>;
  tabKeytips: Map<string, string>;
  backstage: SpecBackstageNode[];
}

/** Index the spec. Tabs without an overlay get the shell's default geometry (fit.refineDefaultLayout). */
export function buildShellModel(spec: SpecModel): ShellModel {
  const controls = new Map<string, SpecControl>();
  const parent = new Map<string, string>();
  const place = new Map<string, {tab: string; group: string}>();
  const visit = (c: SpecMenuEntry, owner: string | null) => {
    if (!isControl(c)) return;
    if (!controls.has(c.id)) controls.set(c.id, c);
    if (owner) parent.set(c.id, owner);
    for (const k of c.items ?? []) visit(k, c.id);
  };
  const tabs: RibbonTab[] = spec.tabs.map(tab => ({
    ...tab,
    groups: tab.groups.map(g => {
      for (const c of g.controls) { visit(c, null); if (isControl(c)) place.set(c.id, {tab: tab.id, group: g.id}); }
      const top = g.controls.filter(isControl);
      const layout = tab.layoutSource === 'default' || !g.layout?.length
        ? refineDefaultLayout(top.map(c => ({id: c.id, type: c.type, size: typeof c.size === 'string' ? c.size : undefined, row: typeof c.row === 'number' ? c.row : undefined})))
        : (g.layout as LayoutItem[]);
      return {id: g.id, key: `${tab.id}/${g.id}`, tab: tab.id, label: g.label, launcher: g.launcher, keytip: g.keytip, collapseOrder: g.collapseOrder,
        collapsedIcon: g.collapsedIcon, layout, widths: g.widths ?? {}, controls: g.controls};
    }),
  }));
  for (const c of spec.qat) visit(c, null);
  // Right-click menus (spec.contextMenus): their entries become controls, run through activate like ribbon items.
  const asControl = (k: SpecMenuItem): SpecMenuEntry => (k.separator ? {separator: true} : {
    type: 'button', shortcut: null, icon: null, source: null, sourceRef: null, ...k, id: k.id ?? '', label: k.label ?? '',
    command: k.command ?? null, dialog: k.dialog ?? null, args: k.args ?? null, items: k.items?.map(asControl),
  } as unknown as SpecControl);
  const contextMenus = (spec.contextMenus ?? []).map(m => ({target: m.target, items: m.items.map(asControl)}));
  for (const m of contextMenus) for (const k of m.items) visit(k, null);
  const tabKeytips = assignKeytips([{id: '#file', label: 'File', preferred: 'F'}, ...tabs.map(t => ({id: t.id, label: t.label, preferred: t.keytip}))]);
  return {app: spec.app, spec, tabs, controls, parent, place, tabKeytips, backstage: spec.backstage, contextMenus};
}

/** Every control a group renders (top level and menu children), depth first. */
export function groupControls(g: {controls: SpecMenuEntry[]}): SpecControl[] {
  const out: SpecControl[] = [];
  const visit = (c: SpecMenuEntry) => { if (!isControl(c)) return; out.push(c); for (const k of c.items ?? []) visit(k); };
  for (const c of g.controls) visit(c);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Args: spec controls carry placeholders ("<font>", "<pt>", "<hex>") where the person supplies the value.

export const PLACEHOLDER = /^<[^>]*>$/;
export const isPlaceholderValue = (v: unknown) => typeof v === 'string' && PLACEHOLDER.test(v);

/** Args without placeholder values (what a plain click runs). */
export function concreteArgs(args: Args | null | undefined): Args {
  const out: Args = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (isPlaceholderValue(v)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = concreteArgs(v as Args);
      if (Object.keys(inner).length) out[k] = inner;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** The (dotted) path of the first placeholder in args, e.g. 'outline.color'. */
export function placeholderPath(args: Args | null | undefined): string[] | null {
  for (const [k, v] of Object.entries(args ?? {})) {
    if (isPlaceholderValue(v)) return [k];
    if (v && typeof v === 'object' && !Array.isArray(v)) { const p = placeholderPath(v as Args); if (p) return [k, ...p]; }
  }
  return null;
}

/** The placeholder text at the first placeholder ('<pt>'), to pick a parser. */
export function placeholderKind(args: Args | null | undefined): string | null {
  const p = placeholderPath(args);
  if (!p) return null;
  let v: unknown = args;
  for (const k of p) v = (v as Args)[k];
  return String(v).slice(1, -1).toLowerCase();
}

/** Fill the first placeholder (or `fallbackKey`) with a value; numeric placeholders get numbers. */
export function fillArgs(args: Args | null | undefined, value: unknown, fallbackKey = 'value'): Args {
  const path = placeholderPath(args) ?? [fallbackKey];
  const kind = placeholderKind(args) ?? '';
  let v = value;
  if (/^(pt|n|deg|number|int|percent|size|px|cm|in|mm|0-|lines|record)/.test(kind) && typeof value === 'string') {
    const n = Number(String(value).replace(/[^0-9.+-]/g, ''));
    if (Number.isFinite(n) && String(value).trim() !== '') v = n;
  }
  const out: Args = JSON.parse(JSON.stringify(args ?? {}));
  let at: Args = out;
  for (let i = 0; i < path.length - 1; i++) { if (!at[path[i]] || typeof at[path[i]] !== 'object') at[path[i]] = {}; at = at[path[i]] as Args; }
  at[path[path.length - 1]] = v;
  return concreteArgs(out);
}

/** Display label without the spec's hints ("Paste Special…" keeps its ellipsis, "(Alt+Q)" notes go). */
export function displayLabel(c: {label: string}): string {
  return String(c.label ?? '').replace(/\s*\((?:[^)]*\+[^)]*|ctrl[^)]*)\)\s*$/i, '').trim();
}

/** Short label for a large button: at most two lines, split near the middle (Word: "Format\nPainter"). */
export function splitLabel(label: string): [string, string | null] {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length < 2 || label.length <= 9) return [label, null];
  let best = 1, bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ').length, b = words.slice(i).join(' ').length;
    const d = Math.abs(a - b);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/** Font combos list installed fonts; size combos list Office's sizes. */
export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
export const isFontCombo = (c: SpecControl) => placeholderKind(c.args) === 'font' || /(^|\.)(font|font-name|font-face)$/.test(c.id);
export const isSizeCombo = (c: SpecControl) => /size/i.test(c.label) && (placeholderKind(c.args) === 'pt' || /font-size$/.test(c.id));
