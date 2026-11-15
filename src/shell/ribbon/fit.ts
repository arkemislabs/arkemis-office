// Ribbon groups that shrink to fit the window (docs/architecture.md section 8.4).
// Translated from wordcraft crates/ui-egui/src/ribbon_fit.rs (`plan`, #662/#1285) at
// 3de6ff95af86c19d67030cd96dba15cd6a45a25e, extended from upstream's three levels to the four the
// architecture names: as the window narrows, groups step down large -> medium -> small, then fold
// into one drop-down button showing `collapsedIcon`; whatever room is left is given back (upstream:
// from the left; groups an overlay orders: in reverse of the order they shrank, as Office does).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Pure: no DOM, no React, no imports of other TS files (tests import it under `node --test`).

/** The group as designed (large buttons with labels under their icons). */
export const FULL = 0;
/** Large buttons become medium rows (icon + label), inline galleries show fewer tiles. */
export const MEDIUM = 1;
/** Medium buttons drop their labels (tooltips keep the names), galleries shrink to their minimum. */
export const SMALL = 2;
/** One drop-down button holding the whole group. */
export const COLLAPSED = 3;
export type Level = 0 | 1 | 2 | 3;
export const LEVELS: readonly Level[] = [FULL, MEDIUM, SMALL, COLLAPSED];

/** Estimated width of a collapsed group (its button and divider) before it is measured. */
export const COLLAPSED_W = 64;

export interface GroupWidths {
  id: string;
  /** Measured widths at FULL, MEDIUM, SMALL, COLLAPSED (null/undefined: not measured yet). */
  widths: (number | null | undefined)[];
  /** Overlay `collapseOrder`: lower numbers shrink first. Groups without one shrink right to left after them. */
  collapseOrder?: number | null;
}

const finite = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);

/** Width of a group at a level, estimating levels not measured yet from the wider ones. */
export function widthAt(g: GroupWidths, level: Level): number {
  const full = finite(g.widths[FULL]) ?? 0;
  const medium = finite(g.widths[MEDIUM]) ?? full;
  const small = finite(g.widths[SMALL]) ?? medium;
  if (level === FULL) return full;
  if (level === MEDIUM) return Math.min(medium, full);
  if (level === SMALL) return Math.min(small, medium, full);
  return finite(g.widths[COLLAPSED]) ?? Math.min(COLLAPSED_W, full);
}

/**
 * The order groups give up room in: overlay `collapseOrder` ascending first (ties right to left),
 * then the remaining groups from the right, as upstream does.
 */
export function shrinkOrder(groups: GroupWidths[]): number[] {
  const idx = groups.map((_, i) => i);
  const ordered = idx.filter(i => finite(groups[i].collapseOrder) !== null)
    .sort((a, b) => (groups[a].collapseOrder! - groups[b].collapseOrder!) || b - a);
  const rest = idx.filter(i => finite(groups[i].collapseOrder) === null).reverse();
  return [...ordered, ...rest];
}

/**
 * Each group's level (by position) so that the row fits `avail`: groups shrink in shrink order,
 * first all to MEDIUM, then to SMALL, then to COLLAPSED, stopping as soon as the row fits. Then
 * whatever room is left is given back in the reverse of the order the groups shrank in:
 *  - groups without an overlay `collapseOrder` (they shrank last) get it back first, upstream's way:
 *    from the left, each as far as it fits (a wide gallery that shrank can make room the groups
 *    shrunk before it no longer need, and a group of large buttons gains nothing collapsed);
 *  - groups the overlay orders get it back exactly in reverse, pass by pass (COLLAPSED -> SMALL,
 *    then SMALL -> MEDIUM, then MEDIUM -> FULL, the last to shrink first), stopping at the first
 *    one that does not fit: Office never restores a group that shrank earlier than one still
 *    shrunk, so PowerPoint's Font (kept for last) is never folded while Designer stays open.
 */
export function plan(groups: GroupWidths[], avail: number): Level[] {
  const levels: Level[] = groups.map(() => FULL);
  const room = Number.isFinite(avail) ? avail : Infinity;
  let total = groups.reduce((sum, g) => sum + widthAt(g, FULL), 0);
  const order = shrinkOrder(groups);
  for (const target of [MEDIUM, SMALL, COLLAPSED] as Level[]) {
    for (const i of order) {
      if (total <= room) break;
      const g = groups[i];
      // A level that saves no room is skipped: a group of large buttons drawn as labelled rows can
      // be wider than as designed (Word's View tab), and drawing it so only overflows the row.
      if (levels[i] < target && widthAt(g, target) >= widthAt(g, levels[i]) && target !== COLLAPSED) continue;
      total += widthAt(g, target) - widthAt(g, levels[i]);
      levels[i] = target;
    }
  }
  /** Widen group i by one level when it fits; false when it does not. */
  const widen = (i: number): boolean => {
    const g = groups[i];
    const wider = (levels[i] - 1) as Level;
    const next = total + widthAt(g, wider) - widthAt(g, levels[i]);
    if (!Number.isFinite(next) || next > room) return false;
    total = next;
    levels[i] = wider;
    return true;
  };
  const ordered = order.filter(i => finite(groups[i].collapseOrder) !== null);
  const free = groups.map((_, i) => i).filter(i => finite(groups[i].collapseOrder) === null);
  for (const i of free) while (levels[i] > FULL && widen(i)) { /* as far as it fits */ }
  restore: for (const from of [COLLAPSED, SMALL, MEDIUM] as Level[]) {
    for (const i of [...ordered].reverse()) {
      if (levels[i] !== from) continue;
      if (!widen(i)) break restore;
    }
  }
  return levels;
}

/** Total width of a plan (for the scroll fallback: collapsed groups that still do not fit scroll). */
export function planWidth(groups: GroupWidths[], levels: Level[]): number {
  return groups.reduce((sum, g, i) => sum + widthAt(g, levels[i] ?? FULL), 0);
}

// ---------------------------------------------------------------------------------------------
// Layout at a level: the overlay's primitives (section 7.3) rearranged for MEDIUM and SMALL.

/** A row entry: a control id (icon-only small button) or {medium: id} (a labelled button on its line). */
export type RowEntry = string | {medium: string};
export type LayoutItem =
  | {large: string} | {medium: string} | {small: string; unplaced?: boolean}
  | {stack: string[]; header?: string} | {rows: RowEntry[][]}
  | {gallery: string; inline?: boolean; columns?: number}
  | {separator: true};

export type Size = 'large' | 'medium' | 'small';
export type RenderItem =
  | {kind: 'large'; id: string}
  | {kind: 'column'; items: {id: string; size: Size}[]; header?: string}
  | {kind: 'rows'; rows: {id: string; size: Size}[][]}
  | {kind: 'gallery'; id: string; columns: number; inline: boolean}
  | {kind: 'separator'};

/** Tiles an inline gallery shows at each level (upstream: "a shorter Styles gallery" when compact). */
export function galleryColumns(columns: number, level: Level): number {
  const c = Math.max(1, Math.round(columns));
  if (level === FULL) return c;
  if (level === MEDIUM) return Math.max(2, Math.ceil(c * 0.6));
  return Math.min(c, 2);
}

/**
 * Rearrange a group's layout for a level. `keep(id)` filters out controls that are not rendered
 * (pending controls in production); `hasIcon(id)` says whether a control can drop its label (a
 * control without an icon keeps it, or it would show nothing).
 */
export function layoutAt(layout: LayoutItem[], level: Level, keep: (id: string) => boolean = () => true,
  hasIcon: (id: string) => boolean = () => true): RenderItem[] {
  const out: RenderItem[] = [];
  const shrink = (size: Size, id: string): Size => {
    if (level >= SMALL && size !== 'small' && hasIcon(id)) return 'small';
    if (level >= MEDIUM && size === 'large') return 'medium';
    return size;
  };
  let pendingLarge: string[] = [];
  const flushLarge = () => {
    for (let i = 0; i < pendingLarge.length; i += 3) {
      out.push({kind: 'column', items: pendingLarge.slice(i, i + 3).map(id => ({id, size: shrink('large', id)}))});
    }
    pendingLarge = [];
  };
  for (const item of layout) {
    if ('large' in item) {
      if (!keep(item.large)) continue;
      if (level === FULL) out.push({kind: 'large', id: item.large});
      else pendingLarge.push(item.large);
      continue;
    }
    flushLarge();
    if ('medium' in item) { if (keep(item.medium)) out.push({kind: 'column', items: [{id: item.medium, size: shrink('medium', item.medium)}]}); }
    else if ('small' in item) { if (keep(item.small)) out.push({kind: 'column', items: [{id: item.small, size: 'small'}]}); }
    else if ('stack' in item) {
      const items = item.stack.filter(keep).map(id => ({id, size: shrink('medium', id)}));
      if (items.length) out.push(item.header ? {kind: 'column', items, header: item.header} : {kind: 'column', items});
    } else if ('rows' in item) {
      // Icon-only entries stay small; a labelled entry ({medium}) drops its label with the rest at SMALL.
      const rows = item.rows.map(r => r.map(x => (typeof x === 'string' ? {id: x, size: 'small' as Size} : {id: x.medium, size: shrink('medium', x.medium)}))
        .filter(x => keep(x.id))).filter(r => r.length);
      if (rows.length) out.push({kind: 'rows', rows});
    } else if ('gallery' in item) {
      if (keep(item.gallery)) out.push({kind: 'gallery', id: item.gallery, inline: item.inline === true, columns: galleryColumns(item.columns ?? 4, level)});
    } else if ('separator' in item) {
      if (out.length && out[out.length - 1].kind !== 'separator') out.push({kind: 'separator'});
    }
  }
  flushLarge();
  while (out.length && out[out.length - 1].kind === 'separator') out.pop();
  while (out.length && out[0].kind === 'separator') out.shift();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Default geometry for tabs without a layout overlay (docs/spec/layout/<app>/<tab>.json).

export interface LayoutControl { id: string; type: string; size?: string; row?: number }
const LARGE_TYPES = new Set(['button', 'toggle', 'split', 'menu', 'gallery', 'color']);

/**
 * Office-like arrangement when no overlay places a group's controls: controls the spec marks large
 * stay large, galleries sit in the ribbon, a group of one or two plain buttons draws them large (as
 * Word's Voice, Editor and Add-ins groups do), and the rest stack three to a column.
 */
export function refineDefaultLayout(controls: LayoutControl[]): LayoutItem[] {
  const list = controls.filter(c => c && c.id);
  const anyLarge = list.some(c => c.size === 'large');
  const lone = !anyLarge && list.length <= 2 && list.every(c => LARGE_TYPES.has(c.type));
  const out: LayoutItem[] = [];
  let stack: string[] = [];
  const flush = () => { if (stack.length) out.push({stack}); stack = []; };
  for (const c of list) {
    if (c.type === 'gallery' && !lone) { flush(); out.push({gallery: c.id, inline: true, columns: list.length === 1 ? 6 : 4}); continue; }
    if (c.size === 'large' || lone) { flush(); out.push({large: c.id}); continue; }
    stack.push(c.id);
    if (stack.length === 3) flush();
  }
  flush();
  return out;
}

/** Whether a level's arrangement differs from the next wider one (levels that change nothing can be skipped). */
export function sameLayout(a: RenderItem[], b: RenderItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
