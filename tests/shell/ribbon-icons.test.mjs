// Every ribbon control draws an icon (design review, 2026-10-30: "instead of svgs they are text options in
// ribbon"). A button whose icon is missing falls back to its label or its initials; this test keeps
// that from coming back. Check boxes (Ruler, Header Row...), labels, combos, spinners and colour
// swatches draw no icon in Office either. Spec notes never appear as menu entries.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isNoteLabel, NOT_NOTES} from '../../scripts/gen/spec.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPS = ['quill', 'grid', 'prism', 'slate', 'folio'];
const NO_ICON = new Set(['label', 'combo', 'spinner', 'palette', 'color']);
const icons = new Set(fs.readdirSync(path.join(root, 'assets/icons/ribbon')).filter(f => f.endsWith('.svg') && !f.endsWith('.32.svg')).map(f => f.slice(0, -4)));

function spec(app) {
  const src = fs.readFileSync(path.join(root, 'src/generated', `${app}.spec.ts`), 'utf8');
  return JSON.parse(JSON.parse(src.slice(src.indexOf('JSON.parse(') + 11, src.lastIndexOf(')'))));
}

for (const app of APPS) {
  test(`${app}: every ribbon button has a drawn icon`, () => {
    const missing = [];
    const visit = (c, where) => {
      if (c.type === 'group') { for (const k of c.items ?? []) visit(k, where); return; }
      if (NO_ICON.has(c.type) || c.kind === 'checkbox') return;
      if (!c.icon || !icons.has(c.icon)) missing.push(`${where} › ${c.label} (${c.icon ?? 'no icon'})`);
    };
    for (const tab of spec(app).tabs) for (const g of tab.groups ?? []) for (const c of g.controls ?? []) visit(c, `${tab.label} › ${g.label}`);
    assert.deepEqual(missing, []);
  });

  test(`${app}: no spec note is shown as a menu entry`, () => {
    const notes = [];
    const visit = c => { for (const k of c.items ?? []) { if (typeof k.label === 'string' && !k.separator && !NOT_NOTES.has(k.type ?? k.kind) && isNoteLabel(k.label)) notes.push(k.label); visit(k); } };
    for (const tab of spec(app).tabs) for (const g of tab.groups ?? []) for (const c of g.controls ?? []) visit(c);
    for (const m of spec(app).contextMenus ?? []) visit(m);
    assert.deepEqual(notes, []);
  });
}

test('note labels are told apart from real commands', () => {
  for (const note of ['Full Word shape library (Lines, Rectangles, Basic Shapes)', '<SHADOW_PRESETS>', 'Normal  {size} all', '3-D Bar variants',
    'Light: TableStyleLight1-21', 'Highlighter: 4, 8, 12, 18, 24 pt', 'Insert Copied Cells / Insert Cut Cells', 'Show Details (when a pivot)']) assert.ok(isNoteLabel(note), note);
  for (const real of ['Paste Special…', 'Switch Row/Column', 'Align Left', 'Rotate Right 90°', 'Scatter with Smooth Lines (and Markers)', 'A4', '1.5 pt', 'Top 10%…'])
    assert.ok(!isNoteLabel(real), real);
});
