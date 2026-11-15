// PDF (folio) skeleton: page.rotate from the bridge on page 1, read back, undone, then
// Edit › Modify page › Rotate pages clockwise from the ribbon; capture to artifacts/skeleton/folio.png.
import test from 'node:test';
import {PDFDocument} from 'pdf-lib';
import {createFile} from '../../../core/model.mjs';
import {runSkeleton} from '../skeleton.mjs';

test('folio skeleton: page.rotate through the bridge and the ribbon, with undo', {timeout: 200_000}, async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText('Page one', {x: 72, y: 700, size: 24});
  pdf.addPage([612, 792]).drawText('Page two', {x: 72, y: 700, size: 24});
  const bytes = await pdf.save();
  const seed = createFile('folio', 'Skeleton PDF');
  seed.id = 'folio-skeleton';
  const page = (id, i) => ({id, sourceIndex: i, width: 612, height: 792, rotation: 0, sourceRotation: 0, overlays: []});
  seed.content = {sourceBase64: Buffer.from(bytes).toString('base64'), sourceName: 'skeleton.pdf', pages: [page('p1', 0), page('p2', 1)], activePageId: 'p1'};
  await runSkeleton({
    app: 'folio', seed, tab: 'edit',
    command: 'page.rotate', params: {pages: [0]}, undoLabel: 'Automation: Rotate page',
    control: 'edit.modify.page-rotate',
    read: '/pages/0/rotation',
    applied: rotation => rotation === 90,
  });
});
