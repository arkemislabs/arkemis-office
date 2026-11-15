// U:folio/page: page.rotate, page.rotate_ccw over schema-1 PDF content.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
import {createFile, validateFile} from '../../core/model.mjs';
import {rotated} from '../../core/folio/commands/page.mjs';

// A minimal valid source: the validator checks the base64 shape, not the PDF bytes.
const page = (id, i, rotation = 0) => ({id, sourceIndex: i, width: 612, height: 792, rotation, sourceRotation: 0, overlays: []});
async function session(pages = [page('p1', 0), page('p2', 1), page('p3', 2, 270)]) {
  const file = createFile('folio', 'Pages');
  file.id = 'doc1';
  file.content = {sourceBase64: 'JVBERi0=', sourceName: 'pages.pdf', pages, activePageId: pages[0]?.id ?? ''};
  return createTestSession('folio', {file});
}
const rotations = t => t.content.pages.map(p => p.rotation);

test('page.rotate turns the current page clockwise, undoably, as "Rotate page"', async () => {
  const t = await session();
  assert.deepEqual(t.state('page.rotate'), {enabled: true});
  const r = await expectUndoRoundTrip(t, 'page.rotate', {}, after => assert.equal(after.read('/pages/0/rotation'), 90));
  assert.equal(r.undoLabel, 'Rotate page');
  assert.deepEqual(r.result, {pages: [0], rotation: [90]});
  validateFile(t.file);
});

test('the selection (/pg:<id>) or the pages param picks the targets; 270 + 90 wraps to 0', async () => {
  const t = await session();
  t.session.setSelection(t.docId, {ranges: [{anchor: '/pg:p2'}, {anchor: '/pg:p3'}]});
  const r = await t.exec('page.rotate');
  assert.equal(r.undoLabel, 'Rotate pages');
  assert.deepEqual(rotations(t), [0, 90, 0]);
  await t.exec('page.rotate_ccw', {pages: [0, 0, 2]});
  assert.deepEqual(rotations(t), [270, 90, 270]);
  await assert.rejects(t.exec('page.rotate', {pages: [3]}), e => e.code === 'not_found' && e.message === 'page 4 does not exist');
  validateFile(t.file);
});

test('without a PDF (or with assembly forbidden) the commands are disabled', async () => {
  const t = await session([]);
  assert.deepEqual(t.state('page.rotate'), {enabled: false, reason: 'no PDF open'});
  await assert.rejects(t.exec('page.rotate'), e => e.code === 'disabled');
});

test('over the bridge rotation is "Automation: Rotate page"', async () => {
  const t = await session();
  const r = await t.bridge('page.rotate_ccw', {pages: [1]});
  assert.equal(r.undoLabel, 'Automation: Rotate page');
  assert.deepEqual(rotations(t), [0, 270, 270]);
});

test('upstream printcraft organize tests.rs rotate_rejects_angles_that_are_not_multiples_of_90 and quarter-turn wrap', () => {
  assert.throws(() => rotated(90, 45), /multiple of 90/);
  assert.throws(() => rotated(90, 91), /multiple of 90/);
  assert.equal(rotated(90, -90), 0);
  // rotate_pages(&[1], -180) on a page at 90 gives 270; indirect (270, 90) -> 0, (-90, 90) -> 0, (90, -180) -> 270.
  assert.equal(rotated(90, -180), 270);
  for (const [current, degrees, expected] of [[270, 90, 0], [-90, 90, 0], [90, -180, 270]]) assert.equal(rotated(current, degrees), expected);
});
