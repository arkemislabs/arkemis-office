// Test decks for the ported deckcraft engine tests of the slide, text, edit, selection and find
// families (U:prism/text): `Session::with_new()` (one title slide) and shapes placed directly in
// the content where deckcraft's tests call shape.insert / insert.textBox (other families).

import {createTestSession} from '../../../core/kernel/testing.mjs';
import {createContent} from '../../../core/prism/schema.mjs';
import {shape, presetGeom} from '../../../core/prism/model/presentation.mjs';
import {bodyFromText, bodyText} from '../../../core/prism/model/text.mjs';
import {colorScheme, fillSolid} from '../../../core/prism/model/style.mjs';
import {currentSlideId, selectedShapeIds, textSelection} from '../../../core/prism/model/doc.mjs';
import {posOf} from '../../../core/prism/model/text.mjs';
import slide from '../../../core/prism/commands/slide.mjs';
import text from '../../../core/prism/commands/text.mjs';
import edit from '../../../core/prism/commands/edit.mjs';
import selection from '../../../core/prism/commands/selection.mjs';
import find from '../../../core/prism/commands/find.mjs';

export const FAMILIES = [slide, text, edit, selection, find];

/**
 * A new presentation (one title slide), current slide selected. `shapes` go onto the title slide
 * (or onto a second, blank slide with `blank: true`, which is then current); the last is selected.
 */
export async function withNew({extra = [], prefs, shapes = [], blank = false, host} = {}) {
  const content = createContent('Deck');
  let sl = content.slides[0];
  if (blank) {
    const lay = content.masters[0].layouts.find(l => l.kind === 'blank').id;
    sl = {...structuredClone(sl), id: '900', layout: lay, shapes: []};
    content.slides.push(sl);
  }
  sl.shapes.push(...structuredClone(shapes));
  for (const s of shapes) content.nextId = Math.max(content.nextId, Number(s.id) || 0);
  content.nextId = Math.max(content.nextId, 900);
  const anchor = shapes.length ? `/sl:${sl.id}/sp:${shapes.at(-1).id}` : `/sl:${sl.id}`;
  return createTestSession('prism', {content, modules: [...FAMILIES, ...extra], prefs, ...(host ? {host} : {}), selection: {ranges: [{anchor, focus: anchor}], primary: 0}});
}

/** deckcraft `new_text_box(rect, text)`. */
export const textBox = (id, [x, y, w, h], t, name) => shape({id, name: name ?? `TextBox ${id}`, xfrm: {x, y, w, h}, textBox: true,
  geom: presetGeom('rect'), text: {...bodyFromText(t), body: {wrap: true, autofit: {kind: 'shape'}}}});
/** deckcraft `shape.insert {preset, rect, text?}` (accent style approximated by an accent1 fill). */
export const rect = (id, [x, y, w, h], t, name, extra = {}) => shape({id, name: name ?? `Rectangle ${id}`, xfrm: {x, y, w, h}, geom: presetGeom('rect'),
  fill: fillSolid(colorScheme('accent1')), text: t === undefined ? {body: {}, paragraphs: []} : bodyFromText(t), ...extra});

export const curSlide = t => t.content.slides.find(s => s.id === currentSlideId(t.content, t.doc.selection));
export const shapeOf = (t, id) => {
  let hit = null;
  const rec = list => { for (const s of list ?? []) { if (s.id === String(id)) hit = s; if (s.kind?.type === 'group') rec(s.kind.children); } };
  for (const sl of t.content.slides) rec(sl.shapes);
  return hit;
};
export const textOf = (t, id) => bodyText(shapeOf(t, id)?.text);
export const selected = t => selectedShapeIds(t.content, t.doc.selection);
/** The text selection as deckcraft's TextSel: {shape, anchor, caret ([p, c])}. */
export function textSel(t) {
  const ts = textSelection(t.content, t.doc.selection);
  if (!ts) return null;
  const sl = t.content.slides.find(s => s.id === ts.slide);
  const body = ts.notes ? sl.notes : shapeOf(t, ts.shape)?.text;
  return {...ts, anchor: posOf(body, ts.anchor), caret: posOf(body, ts.caret)};
}
/** Type one character at a time, as the keyboard does. */
export async function typeChars(t, s) {
  for (const c of s) await t.exec('text.insert', {text: c});
}
