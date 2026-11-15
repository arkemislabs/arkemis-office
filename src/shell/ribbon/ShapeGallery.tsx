// The Shapes gallery (Office: Insert > Shapes): a grid of drawn shapes in Office's categories (Lines,
// Rectangles, Basic Shapes, Block Arrows, ...). Every tile is the preset's own outline from the
// translated geometry (core/prism/model/geom/preset), so the picture is the shape that gets
// inserted. Apps with a short shape list (Quill, Grid, Slate) show their items the same way;
// Prism's gallery offers the whole catalogue.

import type {SpecControl, SpecMenuEntry} from '../../generated/spec-types';
import {build, CATALOG, CATEGORIES, categoryLabel, info} from '../../../core/prism/model/geom/preset/index.mjs';
import {toCommandError} from '../../../core/kernel/errors.mjs';
import {useEngine} from '../engine/EngineProvider';
import {displayLabel, isControl} from '../model';
import {Icon, hasIcon} from '../icons/Icon';
import {MenuList} from './controls';

const SHAPE_COMMANDS = new Set(['insert.shape', 'tool.shape', 'shape.insert', 'shape.change', 'picture.cropToShape']);
/** True for a control whose menu or gallery picks a shape to insert. */
export const isShapePicker = (c: SpecControl) => !!c.command && SHAPE_COMMANDS.has(c.command)
  && ((c.items ?? []).some(k => isControl(k) && shapeOf(k) !== null) || /<preset>/.test(JSON.stringify(c.args ?? null)));

// The apps' own shape kinds (wordcraft/gridcraft `kind`, OneNote `shape`) as preset names.
const KIND: Record<string, string> = {
  rectangle: 'rect', roundedRectangle: 'roundRect', ellipse: 'ellipse', oval: 'ellipse', circle: 'ellipse', triangle: 'triangle',
  'right-triangle': 'rtTriangle', rightTriangle: 'rtTriangle', diamond: 'diamond', line: 'line', arrow: 'straightConnector1', 'double-arrow': 'straightConnector1',
  star: 'star5', heart: 'heart', textBox: 'textBox', parallelogram: 'parallelogram', pentagon: 'pentagon', hexagon: 'hexagon',
  trapezoid: 'trapezoid', cube: 'cube', cylinder: 'can', straightConnector: 'line', elbowConnector: 'bentConnector3', curvedConnector: 'curvedConnector3',
};

function shapeOf(c: SpecControl): string | null {
  const a = (c.args ?? {}) as Record<string, unknown>;
  const kind = typeof a.preset === 'string' && !a.preset.startsWith('<') ? a.preset : typeof a.kind === 'string' ? a.kind : typeof a.shape === 'string' ? a.shape : null;
  if (!kind) return null;
  if (info(kind)) return kind;
  if (kind === 'straightConnector' && a.arrow && a.arrow !== 'none') return 'straightConnector1';
  return KIND[kind] ?? null;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
/** SVG path data for a preset drawn in a `size` square (lines run corner to corner, as in Office's tiles). */
export function presetPath(name: string, size = 18): string | null {
  const g = build(name, size, size);
  if (!g) return null;
  type P = {x: number; y: number};
  type Seg = {t: 'M' | 'L' | 'C' | 'Q' | 'Z'; p: P; p1: P; p2: P};
  let d = '';
  for (const sub of g.paths) for (const s of sub.path as Seg[]) {
    if (s.t === 'M' || s.t === 'L') d += `${s.t}${fmt(s.p.x)} ${fmt(s.p.y)}`;
    else if (s.t === 'C') d += `C${fmt(s.p1.x)} ${fmt(s.p1.y)} ${fmt(s.p2.x)} ${fmt(s.p2.y)} ${fmt(s.p.x)} ${fmt(s.p.y)}`;
    else if (s.t === 'Q') d += `Q${fmt(s.p1.x)} ${fmt(s.p1.y)} ${fmt(s.p.x)} ${fmt(s.p.y)}`;
    else if (s.t === 'Z') d += 'Z';
  }
  return d || null;
}

export function ShapeGlyph({preset, size = 20, arrow = preset === 'straightConnector1'}: {preset: string; size?: number; arrow?: boolean}) {
  const d = presetPath(preset, 18);
  if (!d) return null;
  return <svg className="shape-glyph" viewBox="-1.5 -1.5 21 21" width={size} height={size} aria-hidden="true" focusable="false">
    <path d={d} fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinejoin="round"/>
    {arrow ? <path d="M18 18l-4.5-1.25M18 18l-1.25-4.5" fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round"/> : null}
  </svg>;
}

/** Recently Used Shapes (Office's first group): the last shapes picked, per app, kept in the person's browser storage. */
const RECENT_MAX = 12;
const recentKey = (app: string) => `arkemis.shapes.recent.${app}`;
function readRecent(app: string): string[] {
  try { const v = JSON.parse(localStorage.getItem(recentKey(app)) ?? '[]'); return Array.isArray(v) ? v.filter((x: unknown) => typeof x === 'string' && info(x)).slice(0, RECENT_MAX) : []; } catch { return []; }
}
function remember(app: string, preset: string | null) {
  if (!preset) return;
  try { localStorage.setItem(recentKey(app), JSON.stringify([preset, ...readRecent(app).filter(x => x !== preset)].slice(0, RECENT_MAX))); } catch { /* storage may be blocked */ }
}
/** Word's gallery has no Action Buttons group (PowerPoint's does). */
const HIDDEN_GROUPS: Record<string, string[]> = {quill: ['actionButtons']};

interface Tile { key: string; label: string; preset: string | null; arrow: boolean; icon: string | null; run: () => void }
/** A connector item that ends in an arrowhead (Word's Straight/Elbow/Curved Arrow Connector, Lines › Arrow). */
const hasArrow = (c: SpecControl) => { const a = (c.args ?? {}) as Record<string, unknown>; return a.arrow === 'end' || a.kind === 'arrow' || a.shape === 'arrow' || a.shape === 'double-arrow'; };

export function ShapeGallery({c, onDone}: {c: SpecControl; onDone: () => void}) {
  const {controller} = useEngine();
  const app = String((controller as unknown as {model?: {app?: string}}).model?.app ?? '');
  const run = (id: string, value?: unknown, preset: string | null = null) => {
    remember(app, preset ?? (typeof value === 'string' && info(value) ? value : null));
    onDone();
    controller.activate(id, value === undefined ? {} : {value}).catch(e => controller.notify(toCommandError(e).message, 'error'));
  };
  const items = (c.items ?? []).filter(isControl) as SpecControl[];
  const shapeItems = items.filter(k => shapeOf(k) !== null || (k.command && SHAPE_COMMANDS.has(k.command) && hasIcon(k.icon) && k.args));
  const others: SpecMenuEntry[] = (c.items ?? []).filter(k => !shapeItems.includes(k as SpecControl));
  // Prism: the gallery is the whole catalogue, picked by preset name.
  const tiles: Tile[] = shapeItems.length
    ? shapeItems.filter(k => controller.shows(k)).map(k => ({key: k.id, label: displayLabel(k), preset: shapeOf(k), arrow: hasArrow(k), icon: k.icon, run: () => run(k.id, undefined, shapeOf(k))}))
    : CATALOG.map((p: {name: string; label: string}) => ({key: p.name, label: p.label, preset: p.name, arrow: p.name === 'straightConnector1', icon: null, run: () => run(c.id, p.name)}));
  const groups = new Map<string, Tile[]>();
  for (const t of tiles) {
    const cat = (t.preset && info(t.preset)?.category) || 'basicShapes';
    groups.set(cat, [...(groups.get(cat) ?? []), t]);
  }
  // Crop to Shape takes a closed outline: no lines or connectors.
  const noLines = c.command === 'picture.cropToShape' ? ['lines'] : [];
  const order = CATEGORIES.filter((k: string) => groups.has(k) && !(HIDDEN_GROUPS[app] ?? []).includes(k) && !noLines.includes(k));
  const recent = readRecent(app).map(p => tiles.find(t => t.preset === p)).filter((t): t is Tile => !!t);
  return <div className="shape-gallery" role="none">
    {recent.length ? <section className="shape-gallery-group">
      <div className="shell-menu-header" role="presentation">Recently Used Shapes</div>
      <div className="shape-gallery-grid" role="group" aria-label="Recently Used Shapes">
        {recent.map(t => <button key={`recent-${t.key}`} type="button" role="menuitem" tabIndex={-1} className="shape-tile" title={t.label} aria-label={t.label} onClick={t.run}>
          {t.preset ? <ShapeGlyph preset={t.preset} arrow={t.arrow}/> : null}
        </button>)}
      </div>
    </section> : null}
    {order.map((cat: string) => <section key={cat} className="shape-gallery-group">
      <div className="shell-menu-header" role="presentation">{categoryLabel(cat)}</div>
      <div className="shape-gallery-grid" role="group" aria-label={categoryLabel(cat)}>
        {groups.get(cat)!.map(t => <button key={t.key} type="button" role="menuitem" tabIndex={-1} className="shape-tile" title={t.label} aria-label={t.label}
          onClick={t.run}>
          {t.preset ? <ShapeGlyph preset={t.preset} arrow={t.arrow}/> : hasIcon(t.icon) ? <Icon id={t.icon} size={20}/> : null}
        </button>)}
      </div>
    </section>)}
    {others.some(k => isControl(k) && controller.shows(k)) ? <><div className="shell-menu-sep" role="separator"/><MenuList entries={others} onDone={onDone}/></> : null}
  </div>;
}
