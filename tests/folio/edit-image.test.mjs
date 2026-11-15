// core/folio/lib/page-images.mjs and the edit.images, edit.image_select, edit.image_change and edit.image_replace commands: Edit PDF images.
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. ArtCraft (printcraft 0.16.0 crates/edit/src/images.rs and tests.rs page_images_move_turn_replace_and_delete): the images a page draws are listed with
//    their box and placement; a move, resize, turn or flip is a transform wrapped around the `Do` (a second one folds into it, so repeated moves do not
//    nest one more q each); a crop is a clip in the image's own scope; a replacement draws another picture in the same place; delete removes the `Do`.
//    Acrobat's Edit text & images does the same: turns and flips are about the image as the page shows it.
// 2. Ours does the same: real pages with pictures, read back after each change through the same reader, also on a page whose /Rotate is 90.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument, PDFName} from 'pdf-lib';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {migrateContent} from '../../core/folio/migrate.mjs';
import {schema1Content, editImagePdf, REPLACEMENT_PNG} from '../../core/folio/fixtures.mjs';
import {readImages} from '../../core/folio/lib/page-images.mjs';
import {pageStreams} from '../../core/folio/lib/text-interp.mjs';

const session = async (bytes = null, extra = {}) => {
  const content = {...(await migrateContent(await schema1Content(bytes ?? await editImagePdf(), 'pic.pdf'))), ...extra};
  return createTestSession('folio', {content});
};
const near = (a, b, tol = 1e-3, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);
const nearRect = (a, b, tol = 1e-3, msg = '') => a.forEach((v, i) => near(v, b[i], tol, `${msg} [${i}]`));
const images = async t => (await t.exec('edit.images', {page: 1})).result.images;
const source = async t => PDFDocument.load(Uint8Array.from(Buffer.from(t.content.sourceBase64, 'base64')));
const placed = async t => { const d = await source(t); return readImages(d, d.getPage(0)).images[0].matrix; };
const streamText = async t => { const d = await source(t); return pageStreams(d, d.getPage(0)).map(s => new TextDecoder('latin1').decode(s.bytes)).join('\n'); };
/** How many `q` operators the page's streams hold. */
const count = text => (text.match(new RegExp(String.raw`\bq\b`, 'g')) ?? []).length;

test('the images of a page are listed with their box in user space and in page view points', async () => {
  const t = await session();
  const list = await images(t);
  assert.equal(list.length, 1);
  const im = list[0];
  assert.equal(im.name, 'Im1');
  assert.deepEqual([im.width, im.height, im.isForm], [16, 12, false]);
  nearRect(im.userRect, [400, 590, 540, 690]);
  nearRect(im.rect, [400, 102, 540, 202], 1e-6, 'view space is y down');
});

test('a stream a mark added is not a page image', async () => {
  const doc = await PDFDocument.load(await editImagePdf());
  const page = doc.getPage(0);
  const mark = doc.context.register(doc.context.flateStream('q 50 0 0 50 100 100 cm /Im1 Do Q', {PCMark: 'Watermark'}));
  const list = page.node.Contents() ? [page.node.get(PDFName.of('Contents'))] : [];
  page.node.set(PDFName.of('Contents'), doc.context.obj([...list, mark]));
  assert.equal(readImages(doc, page).images.length, 1, "only the page's own picture");
});

test('turning and flipping happen about the centre of the image as the page shows it', async () => {
  const t = await session();
  const view = (await images(t))[0].rect;
  const [cx, cy] = [(view[0] + view[2]) / 2, (view[1] + view[3]) / 2];
  const [w, h] = [view[2] - view[0], view[3] - view[1]];
  await t.exec('edit.image_select', {page: 1, index: 0});
  await t.exec('edit.image_change', {change: 'rotate_cw'});
  nearRect((await images(t))[0].rect, [cx - h / 2, cy - w / 2, cx + h / 2, cy + w / 2], 1e-3, 'a quarter turn swaps the sides about the centre');
  await t.exec('edit.image_change', {change: 'rotate_ccw'});
  nearRect((await images(t))[0].rect, view, 1e-3, 'clockwise then counterclockwise is where it started');
  await t.exec('edit.image_change', {change: 'flip_h'});
  nearRect((await images(t))[0].rect, view, 1e-3, 'a flip keeps the box');
  const m = await placed(t);
  assert.ok(m[0] < 0 && m[3] > 0, `mirrored left to right: ${m}`);
  await t.exec('edit.image_change', {change: 'flip_v'});
  const m2 = await placed(t);
  assert.ok(m2[0] < 0 && m2[3] < 0, `and then top to bottom: ${m2}`);
  for (let i = 0; i < 4; i++) await t.exec('edit.image_change', {change: 'rotate_cw'});
  nearRect((await images(t))[0].rect, view, 1e-3, 'four quarter turns come back');
});

test('on a page turned 90 degrees a clockwise turn is clockwise as shown', async () => {
  const doc = await PDFDocument.load(await editImagePdf());
  doc.getPage(0).setRotation({type: 'degrees', angle: 90});
  const t = await session(await doc.save());
  const before = (await images(t))[0];
  const m0 = await placed(t);
  await t.exec('edit.image_select', {page: 1, index: 0});
  await t.exec('edit.image_change', {change: 'rotate_cw'});
  const after = (await images(t))[0];
  near((after.rect[0] + after.rect[2]) / 2, (before.rect[0] + before.rect[2]) / 2, 1e-3);
  near((after.rect[1] + after.rect[3]) / 2, (before.rect[1] + before.rect[3]) / 2, 1e-3);
  near(after.rect[2] - after.rect[0], before.rect[3] - before.rect[1], 1e-3, 'the sides swap as shown');
  const m1 = await placed(t);
  assert.notDeepEqual(m1.map(v => +v.toFixed(6)), m0.map(v => +v.toFixed(6)));
  // Clockwise as shown: on this page the displayed right is user up, so the user-space turn is counterclockwise there.
  assert.ok(m1[1] * m1[2] < 0 || m1[0] * m1[3] < 0, `a quarter turn matrix: ${m1}`);
});

test('a move and a resize fold into the q cm Do Q the image sits in, and wrap a bare Do once', async () => {
  // The picture is drawn as `q cm Do Q`: the transform goes into that cm.
  const t = await session();
  await t.exec('edit.image_select', {page: 1, index: 0});
  const before = (await images(t))[0];
  const text0 = await streamText(t);
  await t.exec('edit.image_change', {change: 'move', offset: [30, 20]});
  nearRect((await images(t))[0].rect, [before.rect[0] + 30, before.rect[1] + 20, before.rect[2] + 30, before.rect[3] + 20]);
  assert.equal(count(await streamText(t), /q/g), count(text0, /q/g), 'folded into the existing cm: no new q');
  await t.exec('edit.image_change', {change: 'move', offset: [-10, 5]});
  await t.exec('edit.image_change', {change: 'resize', rect: [before.rect[0], before.rect[1], before.rect[0] + 70, before.rect[1] + 100]});
  nearRect((await images(t))[0].rect, [before.rect[0], before.rect[1], before.rect[0] + 70, before.rect[1] + 100], 1e-3, 'resized to the box asked for');
  assert.equal(count(await streamText(t), /q/g), count(text0, /q/g));
  await assert.rejects(() => t.exec('edit.image_change', {change: 'resize', rect: [10, 10, 10.2, 10.2]}), /smaller than a point/);

  // A Do with no q around it: the first change wraps it in one q, the next ones fold into that.
  const doc = await PDFDocument.load(await editImagePdf());
  const page = doc.getPage(0);
  const streams = pageStreams(doc, page);
  const last = streams.length - 1;
  const text = new TextDecoder('latin1').decode(streams[last].bytes).replace('q 140 0 0 100 400 590 cm /Im1 Do Q', '140 0 0 100 400 590 cm /Im1 Do');
  const refs = page.node.Contents();
  void refs;
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(text)));
  const bare = await session(await doc.save());
  const base = count(await streamText(bare), /q/g);
  await bare.exec('edit.image_change', {page: 1, index: 0, change: 'move', offset: [30, 20]});
  assert.equal(count(await streamText(bare), /q/g), base + 1, 'the first move wraps the Do in one q');
  await bare.exec('edit.image_change', {page: 1, index: 0, change: 'move', offset: [5, 5]});
  assert.equal(count(await streamText(bare), /q/g), base + 1, 'the next one folds into it');
  nearRect((await images(bare))[0].rect, [435, 127, 575, 227], 1e-3);
});

test("a crop is a clip in the image's own scope; the pixels are kept", async () => {
  const t = await session();
  await t.exec('edit.image_select', {page: 1, index: 0});
  await t.exec('edit.image_change', {change: 'crop', percent: 10});
  assert.match(await streamText(t), /q\s+0\.1 0\.1 0\.8 0\.8 re\s+W\s+n\s+\/Im1 Do\s+Q/);
  await assert.rejects(() => t.exec('edit.image_change', {change: 'crop', percent: 60}), /percent|49/i);
  await assert.rejects(() => t.exec('edit.image_change', {change: 'crop', percent: 'lots'}), /percent/);
});

test('a replacement draws another picture in the same place; delete removes the image', async () => {
  const t = await session();
  const before = (await images(t))[0];
  await t.exec('edit.image_select', {page: 1, index: 0});
  const r = (await t.exec('edit.image_replace', {base64: REPLACEMENT_PNG, name: 'red.png'})).result;
  assert.match(r.image.name, /^PCImg\d+$/);
  nearRect(r.image.userRect, before.userRect, 1e-6, 'drawn in the same place');
  assert.equal(r.image.width, 1);
  const xo = (await source(t)).getPage(0).node.Resources().lookup(PDFName.of('XObject'));
  assert.ok(xo.keys().some(k => k.decodeText() === r.image.name), 'the picture is a page resource');
  await assert.rejects(() => t.exec('edit.image_replace', {base64: Buffer.from('not a picture').toString('base64'), name: 'x.png'}), /PNG|JPEG|picture/);
  await t.exec('edit.image_change', {change: 'delete'});
  assert.equal((await images(t)).length, 0);
  assert.doesNotMatch(await streamText(t), /\bDo\b/);
});

test('the Image controls need an image: they say what to do first, then act on the selected one', async () => {
  const t = await session();
  const st = await t.state('edit.image_change', {change: 'rotate_cw'});
  assert.equal(st.enabled, false);
  assert.match(st.reason, /Click an image/);
  await t.exec('edit.image_select', {page: 1, index: 0});
  assert.equal((await t.state('edit.image_change', {change: 'rotate_cw'})).enabled, true);
  assert.equal((await t.state('edit.image_replace', {})).enabled, true);
  await assert.rejects(() => t.exec('edit.image_select', {page: 1, index: 7}), /no such image/);
  await t.exec('edit.image_select', {});
  assert.equal((await t.state('edit.image_change', {change: 'rotate_cw'})).enabled, false, 'putting the selection down disables them again');
});

test('a protected document refuses changing its images', async () => {
  const t = await session(null, {permissions: {modify: false}});
  await assert.rejects(() => t.exec('edit.image_change', {page: 1, index: 0, change: 'rotate_cw'}), /security settings/);
});

test("a crop moves with its image: the clip lies in the scope the transform wraps (images.rs image_transform_scope)", async () => {
  const {parseContent, mul, at} = await import('../../core/folio/lib/redact-content.mjs');
  const clipBox = async t => {
    const ops = parseContent(new TextEncoder().encode(await streamText(t)));
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    let rect = null;
    for (const op of ops) {
      const n = i => op.args[i].v;
      if (op.op === 'q') stack.push(ctm);
      else if (op.op === 'Q') ctm = stack.pop() ?? ctm;
      else if (op.op === 'cm') ctm = mul([0, 1, 2, 3, 4, 5].map(n), ctm);
      else if (op.op === 're') rect = [n(0), n(1), n(0) + n(2), n(1) + n(3)];
      else if (op.op === 'W') {
        const pts = [[rect[0], rect[1]], [rect[2], rect[3]]].map(([x, y]) => at(ctm, x, y));
        return [Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1])];
      }
    }
    return null;
  };
  const t = await session();
  await t.exec('edit.image_select', {page: 1, index: 0});
  await t.exec('edit.image_change', {change: 'crop', percent: 10});
  const before = await clipBox(t);
  nearRect(before, [414, 600, 526, 680], 1e-3, 'the crop is 10 percent in from each side of 140 x 100 at (400, 590)');
  await t.exec('edit.image_change', {change: 'move', offset: [30, 20]});
  nearRect(await clipBox(t), [444, 580, 556, 660], 1e-3, 'the clip moved with the picture (view down is user down)');
  await t.exec('edit.image_change', {change: 'rotate_cw'});
  const turned = (await images(t))[0];
  assert.ok(turned.rect[2] - turned.rect[0] < turned.rect[3] - turned.rect[1], 'the picture was turned');
  const box = await clipBox(t);
  assert.ok(box[2] - box[0] < box[3] - box[1], `the clip was turned with it: ${box}`);
});
