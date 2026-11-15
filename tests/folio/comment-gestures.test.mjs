// core/folio/lib/comment-gestures.mjs: which gesture each comment / Fill & Sign / signing tool
// takes on the page and the command it becomes.
//
// Behaviour fidelity: 1. ArtCraft (tools/comments/input.rs): a note, Insert text and Attach take a
// click; a text box takes a click (fits its text) or a drag (keeps its width); a callout, line,
// arrow, rectangle and oval take a drag (a short drag is a slip); polygons and clouds take clicks
// and close on the first point; connected lines finish on double-click/Enter; the eraser follows
// the pointer; Fill & Sign tools and stamps take a click; Digitally sign takes a dragged area and
// then the dialog. Acrobat's tools take the same gestures. 2. Ours maps the same gestures to the
// commands tests/folio/comment.test.mjs and sign.test.mjs prove. 3. This file.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {gestureFor, callFor, closesPolygon} from '../../core/folio/lib/comment-gestures.mjs';
import {releaseTextSources} from '../../core/folio/model/page-text.mjs';

after(() => releaseTextSources());

test('each tool takes the gesture input.rs gives it', () => {
  assert.equal(gestureFor('comment.note').kind, 'click');
  assert.equal(gestureFor('comment.freetext').kind, 'drag');
  assert.equal(gestureFor('comment.polygon').closes, true);
  assert.equal(gestureFor('comment.polyline').closes, false);
  assert.equal(gestureFor('comment.eraser').kind, 'stroke');
  assert.equal(gestureFor('sign.fill.check').kind, 'click');
  assert.equal(gestureFor('sign.digital').dialog, 'dialog.sign-digital-id');
  assert.equal(gestureFor('comment.highlight'), null, 'text markup is the surface\'s own selection gesture');
});

test('slips make nothing; a short text-box drag is a click; a polygon closes on its first point', () => {
  assert.equal(callFor('comment.square', 'p1', [[10, 10], [12, 12]]), null);
  assert.deepEqual(callFor('comment.freetext', 'p1', [[10, 10], [12, 11]], {text: 'x'}).params, {page: 'p1', at: [10, 10], text: 'x'});
  assert.deepEqual(callFor('comment.freetext', 'p1', [[10, 10], [110, 40]], {text: 'x'}).params.rect, [10, 10, 100, 30]);
  assert.equal(callFor('comment.note', 'p1', [[10, 10]], {text: '  '}), null, 'an empty composer posts nothing');
  assert.ok(closesPolygon('comment.polygon', [[0, 0], [50, 0], [25, 40]], [2, 2]));
  assert.ok(!closesPolygon('comment.polyline', [[0, 0], [50, 0], [25, 40]], [2, 2]));
  assert.deepEqual(callFor('sign.certify', 'p1', [[10, 10], [210, 70]]), {dialog: 'dialog.sign-digital-id', init: {page: 'p1', rect: [10, 10, 200, 60], certify: 2}});
});

test('the calls run: every gesture tool makes its comment through its command', async () => {
  const t = await createTestSession('folio', {fixture: 'textPages'});
  const calls = [
    callFor('comment.note', 'p1', [[50, 50]], {text: 'n'}), callFor('comment.callout', 'p1', [[50, 300], [200, 250]], {text: 'c'}),
    callFor('comment.line', 'p1', [[50, 400], [150, 420]]), callFor('comment.cloud', 'p1', [[300, 300], [400, 300], [350, 380]]),
    callFor('comment.stamp', 'p1', [[300, 500]], {view: {stamp: 'Approved'}}), callFor('sign.fill.check', 'p1', [[100, 600]]),
    callFor('sign.fill.text', 'p1', [[100, 650]], {text: 'Jane'}),
  ];
  for (const c of calls) await t.exec(c.command, c.params);
  assert.deepEqual(t.content.pages[0].annots.map(r => r.dict.Subtype), ['/Text', '/FreeText', '/Line', '/Polygon', '/Stamp', '/Stamp', '/FreeText']);
});
