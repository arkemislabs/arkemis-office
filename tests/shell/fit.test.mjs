// Ribbon fit and collapse (src/shell/ribbon/fit.ts). The first group of tests ports wordcraft
// crates/ui-egui/src/ribbon_fit.rs `mod tests` (FULL / COMPACT / COLLAPSED -> FULL / MEDIUM / COLLAPSED
// here, with SMALL in between), the rest cover the four-level plan and the layout transforms.
import test from 'node:test';
import assert from 'node:assert/strict';
import {plan, widthAt, shrinkOrder, layoutAt, refineDefaultLayout, galleryColumns, planWidth, FULL, MEDIUM, SMALL, COLLAPSED} from '../../src/shell/ribbon/fit.ts';

// Upstream's three widths map to FULL, MEDIUM and COLLAPSED; SMALL is "not measured" (= MEDIUM).
const g = (id, full, compact, collapsed) => ({id, widths: [full, compact, null, collapsed]});

test('ribbon_fit::everything_full_when_it_fits', () => {
  const gs = [g('A', 100, 80, 60), g('B', 100, 80, 60)];
  assert.deepEqual(plan(gs, 200), [FULL, FULL]);
});

test('ribbon_fit::rightmost_groups_compact_first_then_collapse', () => {
  const gs = [g('A', 100, 80, 60), g('B', 100, 80, 60), g('C', 100, 80, 60)];
  assert.deepEqual(plan(gs, 285), [FULL, FULL, MEDIUM]);
  // All compact is 240 (SMALL costs what MEDIUM does); then C collapses (220) to fit 230.
  const p = plan(gs, 230);
  assert.equal(p[2], COLLAPSED);
  assert.ok(p.slice(0, 2).every(l => l === MEDIUM || l === SMALL));
  assert.ok(planWidth(gs, p) <= 230);
  assert.ok(plan(gs, 10).every(l => l === COLLAPSED));
});

test('ribbon_fit::groups_that_still_fit_are_given_back', () => {
  const gs = [g('Font', 300, 250, 60), g('Styles', 500, 500, 60), g('Voice', 60, 60, 60), g('Editor', 60, 60, 60)];
  assert.deepEqual(plan(gs, 800), [FULL, COLLAPSED, FULL, FULL]);
});

test('ribbon_fit::trimmed_gallery_keeps_styles_open', () => {
  const gs = [g('Clipboard', 130, 70, 60), g('Font', 330, 290, 60), g('Paragraph', 300, 280, 60), g('Styles', 520, 290, 60), g('Editing', 80, 40, 60), g('Voice', 60, 60, 60)];
  const p = plan(gs, 1250);
  assert.notEqual(p[3], COLLAPSED, 'Styles stays a gallery');
  assert.ok(planWidth(gs, p) <= 1250);
  const wide = gs.map((x, i) => (i === 3 ? g('Styles', 520, 520, 60) : x));
  assert.equal(plan(wide, 1250)[3], COLLAPSED);
});

test('ribbon_fit::same_titles_keep_their_own_levels', () => {
  const gs = [g('New Group', 300, 300, 60), g('New Group', 100, 100, 60)];
  assert.deepEqual(plan(gs, 200), [COLLAPSED, FULL]);
});

test('ribbon_fit::unmeasured_widths_are_estimated', () => {
  const gs = [{id: 'A', widths: [200]}, {id: 'B', widths: [200]}];
  assert.deepEqual(plan(gs, 300), [FULL, COLLAPSED]);
  // Hostile numbers don't throw.
  plan([{id: 'X', widths: [NaN]}, {id: 'Y', widths: [Infinity, NaN]}], 100);
  plan([{id: 'X', widths: [NaN]}], NaN);
});

test('four levels: medium, then small, then collapsed, each only as far as needed', () => {
  const gs = [{id: 'A', widths: [200, 150, 100, 60]}, {id: 'B', widths: [200, 150, 100, 60]}];
  assert.deepEqual(plan(gs, 400), [FULL, FULL]);
  assert.deepEqual(plan(gs, 350), [FULL, MEDIUM]);
  assert.deepEqual(plan(gs, 300), [MEDIUM, MEDIUM]);
  assert.deepEqual(plan(gs, 250), [MEDIUM, SMALL]);
  assert.deepEqual(plan(gs, 200), [SMALL, SMALL]);
  assert.deepEqual(plan(gs, 160), [SMALL, COLLAPSED]);
  assert.deepEqual(plan(gs, 120), [COLLAPSED, COLLAPSED]);
});

test('collapseOrder: lower numbers shrink first, the rest from the right', () => {
  const gs = [{id: 'A', widths: [200, 100, 100, 60], collapseOrder: 1}, {id: 'B', widths: [200, 100, 100, 60]}, {id: 'C', widths: [200, 100, 100, 60]}];
  assert.deepEqual(shrinkOrder(gs), [0, 2, 1]);
  assert.deepEqual(plan(gs, 500), [MEDIUM, FULL, FULL]);
  assert.deepEqual(plan(gs, 400), [MEDIUM, FULL, MEDIUM]);
});

test('collapseOrder: room goes back in reverse shrink order, so a group kept for last is never folded while cheaper ones stay open', () => {
  // PowerPoint Home: Clipboard (co 1), Font (co 9, wide), Designer (co 2), Voice (co 3), from the left.
  const gs = [
    {id: 'clipboard', widths: [120, 90, 70, 60], collapseOrder: 1},
    {id: 'font', widths: [400, 360, 300, 60], collapseOrder: 9},
    {id: 'designer', widths: [80, 70, 50, 60], collapseOrder: 2},
    {id: 'voice', widths: [80, 70, 50, 60], collapseOrder: 3},
  ];
  // Everything cheaper collapses (240) and Font still does not fit as SMALL (300 + 180 > 420): Font folds.
  // Upstream's left-first give-back would then reopen Designer and Voice; Office keeps them folded too.
  const p = plan(gs, 420);
  assert.equal(p[1], COLLAPSED);
  assert.deepEqual(p, [COLLAPSED, COLLAPSED, COLLAPSED, COLLAPSED]);
  // Everything SMALL fits 500 (470): Font would be the first to get MEDIUM back (530) and does not
  // fit, so nothing that shrank before it is widened either.
  assert.deepEqual(plan(gs, 500), [SMALL, SMALL, SMALL, SMALL]);
  // 465 with a narrow collapsed Clipboard (20): it collapses (420) and stays so, Font comes back to SMALL only.
  const narrow = [{...gs[0], widths: [120, 90, 70, 20]}, ...gs.slice(1)];
  const q = plan(narrow, 465);
  assert.deepEqual(q, [COLLAPSED, SMALL, SMALL, SMALL]);
  assert.ok(planWidth(narrow, q) <= 465);
});

test('widthAt never reports a narrower level as wider', () => {
  const x = {id: 'A', widths: [100, 120, 130, 200]};
  assert.ok(widthAt(x, MEDIUM) <= widthAt(x, FULL));
  assert.ok(widthAt(x, SMALL) <= widthAt(x, MEDIUM));
  assert.equal(widthAt({id: 'B', widths: [40]}, COLLAPSED), 40, 'a collapsed estimate never exceeds the full width');
});

test('layoutAt: large buttons become medium stacks, medium drops labels only with an icon', () => {
  const layout = [{large: 'paste'}, {stack: ['cut', 'copy', 'painter']}, {large: 'a'}, {large: 'b'}, {gallery: 'styles', inline: true, columns: 6}];
  assert.deepEqual(layoutAt(layout, FULL).map(x => x.kind), ['large', 'column', 'large', 'large', 'gallery']);
  const medium = layoutAt(layout, MEDIUM);
  assert.deepEqual(medium[0], {kind: 'column', items: [{id: 'paste', size: 'medium'}]});
  assert.deepEqual(medium[2], {kind: 'column', items: [{id: 'a', size: 'medium'}, {id: 'b', size: 'medium'}]});
  assert.equal(medium[3].columns, galleryColumns(6, MEDIUM));
  const small = layoutAt(layout, SMALL, () => true, id => id !== 'copy');
  assert.deepEqual(small[1].items.map(i => i.size), ['small', 'medium', 'small'], 'a control without an icon keeps its label');
  assert.ok(small[3].columns <= 2);
});

test('layoutAt drops controls that are not rendered and empty separators', () => {
  const layout = [{separator: true}, {stack: ['x', 'y']}, {separator: true}, {separator: true}, {large: 'z'}, {separator: true}];
  const out = layoutAt(layout, FULL, id => id !== 'z');
  assert.deepEqual(out, [{kind: 'column', items: [{id: 'x', size: 'medium'}, {id: 'y', size: 'medium'}]}]);
  assert.deepEqual(layoutAt([{rows: [['a', 'b'], ['c']]}], FULL, id => id !== 'c'), [{kind: 'rows', rows: [[{id: 'a', size: 'small'}, {id: 'b', size: 'small'}]]}]);
});

test('rows: a {medium} entry is a labelled button on its line, losing its label at SMALL only with an icon (wordcraft mailings.rs Preview Results)', () => {
  const layout = [{rows: [['first', 'prev', 'next'], [{medium: 'find'}], [{medium: 'check'}]]}];
  const full = layoutAt(layout, FULL);
  assert.deepEqual(full, [{kind: 'rows', rows: [
    [{id: 'first', size: 'small'}, {id: 'prev', size: 'small'}, {id: 'next', size: 'small'}],
    [{id: 'find', size: 'medium'}], [{id: 'check', size: 'medium'}]]}]);
  const small = layoutAt(layout, SMALL, () => true, id => id !== 'check');
  assert.deepEqual(small[0].rows.slice(1), [[{id: 'find', size: 'small'}], [{id: 'check', size: 'medium'}]]);
});

test('stack header: an optional column title over a stack (wordcraft layout.rs Paragraph "Indent" / "Spacing")', () => {
  assert.deepEqual(layoutAt([{stack: ['left', 'right'], header: 'Indent'}], FULL),
    [{kind: 'column', items: [{id: 'left', size: 'medium'}, {id: 'right', size: 'medium'}], header: 'Indent'}]);
  assert.deepEqual(layoutAt([{stack: ['a']}], FULL), [{kind: 'column', items: [{id: 'a', size: 'medium'}]}]);
});

test('default geometry: lone buttons are large, galleries inline, the rest in stacks of three', () => {
  assert.deepEqual(refineDefaultLayout([{id: 'dictate', type: 'split'}]), [{large: 'dictate'}]);
  assert.deepEqual(refineDefaultLayout([{id: 'styles', type: 'gallery'}, {id: 'pane', type: 'button'}, {id: 'x', type: 'combo'}]),
    [{gallery: 'styles', inline: true, columns: 4}, {stack: ['pane', 'x']}]);
  const many = refineDefaultLayout(['a', 'b', 'c', 'd'].map(id => ({id, type: 'button'})));
  assert.deepEqual(many, [{stack: ['a', 'b', 'c']}, {stack: ['d']}]);
  assert.deepEqual(refineDefaultLayout([{id: 'p', type: 'split', size: 'large'}, {id: 'c', type: 'button'}]), [{large: 'p'}, {stack: ['c']}]);
});
