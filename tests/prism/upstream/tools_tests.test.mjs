// Ported from deckcraft crates/engine/src/tools.rs `mod tests` (resize_corner_and_flip,
// resize_rotated_keeps_opposite_corner) and crates/engine/src/keys.rs `mod tests`
// (shortcut_parsing) at f893f6af7d36a5409fd804e81a34fd895cfefedf, for the translations in
// core/prism/lib/pointer.mjs and core/prism/lib/keys.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {resizeBox} from '../../../core/prism/lib/pointer.mjs';
import {shortcutMatches} from '../../../core/prism/lib/keys.mjs';
import {xfrmAffine} from '../../../core/prism/model/geom/index.mjs';
import {apply} from '../../../core/prism/model/geom/kurbo.mjs';

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('tools.rs resize_corner_and_flip', () => {
  const o = {x: 100, y: 100, w: 100, h: 50};
  let n = resizeBox(o, 4, {x: 20, y: 10}, false, false);
  assert.ok(near(n.x, 100) && near(n.w, 120) && near(n.h, 60), JSON.stringify(n));
  n = resizeBox(o, 0, {x: 10, y: 10}, false, false);
  assert.ok(near(n.x, 110) && near(n.w, 90), JSON.stringify(n));
  n = resizeBox(o, 3, {x: -150, y: 0}, false, false);
  assert.ok(n.flipH && near(n.w, 50) && near(n.x, 50), JSON.stringify(n));
  n = resizeBox(o, 4, {x: 100, y: 0}, true, false);
  assert.ok(near(n.w / n.h, 2), JSON.stringify(n));
  n = resizeBox(o, 3, {x: 10, y: 0}, false, true);
  assert.ok(near(n.w, 120) && near(n.x, 90), JSON.stringify(n));
});

test('tools.rs resize_rotated_keeps_opposite_corner', () => {
  const o = {x: 100, y: 100, w: 100, h: 50, rot: 90};
  const anchor = apply(xfrmAffine(o), {x: 0, y: 0});
  const n = resizeBox(o, 4, {x: -10, y: 30}, false, false);
  const anchor2 = apply(xfrmAffine(n), {x: 0, y: 0});
  assert.ok(Math.hypot(anchor.x - anchor2.x, anchor.y - anchor2.y) < 1e-6, `${JSON.stringify(anchor)} ${JSON.stringify(anchor2)}`);
});

test('keys.rs shortcut_parsing', () => {
  const m = (shift, alt, cmd) => ({shift, alt, cmd});
  assert.ok(shortcutMatches('Cmd+B', 'b', m(false, false, true)));
  assert.ok(!shortcutMatches('Cmd+B', 'b', m(true, false, true)));
  assert.ok(shortcutMatches('Cmd+Shift+]', ']', m(true, false, true)));
  assert.ok(shortcutMatches('Cmd+Shift+.', '.', m(true, false, true)));
  assert.ok(shortcutMatches('Delete', 'Delete', m(false, false, false)));
});
