// The shapes of Insert › Shapes (U:quill/shapes-gallery): Office's whole catalogue, drawn from the preset geometry core/prism already has
// (core/prism/model/geom/preset, translated from deckcraft crates/geom). A Word shape's `kind` is one of its own names (rectangle,
// roundedRectangle, ellipse, ...) or, for the rest, the preset's OOXML name (`wedgeRectCallout`, `chevron`, `flowChartProcess`), which is what a
// .docx stores in `a:prstGeom`. No DOM, no Node built-ins.

import {info, build, CATALOG, categoryLabel, CATEGORIES} from '../../prism/model/geom/preset/index.mjs';

export {CATALOG, CATEGORIES, categoryLabel};

/** Word's own kind of a preset (the kinds the shape commands and the file reader already know), or the preset's name. */
const KIND_OF_PRESET = {rect: 'rectangle', roundRect: 'roundedRectangle', ellipse: 'ellipse', flowChartOr: 'flowchartOr', triangle: 'triangle', rtTriangle: 'rightTriangle',
  diamond: 'diamond', line: 'line', straightConnector1: 'straightConnector', bentConnector3: 'elbowConnector', curvedConnector3: 'curvedConnector', rightArrow: 'arrow',
  leftArrow: 'arrowLeft', upArrow: 'arrowUp', downArrow: 'arrowDown', star5: 'star', heart: 'heart'};
const PRESET_OF_KIND = Object.fromEntries(Object.entries(KIND_OF_PRESET).map(([p, k]) => [k, p]));
PRESET_OF_KIND.textBox = 'rect';
PRESET_OF_KIND.freeform = 'rect';

/** The preset a kind is drawn from (null: not a known preset). */
export const presetOfKind = kind => { const n = PRESET_OF_KIND[kind] ?? kind; return info(n) ? n : null; };
/** The kind a preset is stored as, or null when the catalogue has no such preset. */
export const kindOfPreset = name => (info(name) ? KIND_OF_PRESET[name] ?? name : null);

const OPEN = new Set(['line', 'lineInv', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'bentConnector4', 'bentConnector5', 'curvedConnector2', 'curvedConnector3',
  'curvedConnector4', 'curvedConnector5']);
/** A line or connector preset (drawn as an open path, never filled). */
export const isOpenPreset = name => OPEN.has(name);

/** The preset's outline in a w x h frame as drawing steps: [{t: 'M'|'L'|'C'|'Q'|'Z', p, p1, p2}] (see core/prism/model/geom/kurbo.mjs). */
export function presetSteps(name, w, h) {
  const g = build(name, w, h);
  return g ? g.paths.flatMap(p => p.path) : null;
}
