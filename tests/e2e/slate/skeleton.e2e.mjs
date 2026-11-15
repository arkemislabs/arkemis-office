// Slate skeleton: surface.moveContainer from the bridge on a schema-2 notebook page, read back,
// undone, then the same move by dragging the container's top bar through ui.pointer; capture to
// artifacts/skeleton/slate.png.
//
// What OneNote does: dragging a note container's top bar moves it, one undo step. What this
// proves: the bridge's engine.execute and its ui.pointer route (RendererBridge ->
// SurfaceHandle.pointer, the surface's own drag code) make the same edit, and undo takes it back.
// The seed is an older Slate page converted with core/slate/migrate.mjs, as the host converts it
// when it opens it. (page.new is written against schema 1 until the pages family moves:
// design note F-slate--pages--notebook-state.)
import test from 'node:test';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/slate/migrate.mjs';
import {runSkeleton} from '../skeleton.mjs';

test('slate skeleton: moving a note container through the bridge and ui.pointer, with undo', {timeout: 200_000}, async () => {
  const old = createFile('slate', 'Skeleton page');
  old.id = 'slate-skeleton';
  old.content.notebook = 'Course notes';
  old.content.section = 'Week 1';
  old.content.doc = {type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text: 'Notes from the first lecture.'}]}]};
  const seed = migrateFile(old);
  const page = 'slate-skeleton';
  const box = seed.content.pages[page].body.content[0].attrs;
  const to = {x: 300, y: 260};
  await runSkeleton({
    app: 'slate', seed,
    command: 'surface.moveContainer', params: {page, container: box.id, ...to}, undoLabel: 'Automation: Move',
    again: async ({app, doc}) => {
      const from = {x: box.x + 12, y: box.y + 2};
      const r = await app.rpc('ui.pointer', {doc, action: 'drag', target: `bar:${box.id}`, ...from, to: {x: from.x + to.x - box.x, y: from.y + to.y - box.y}});
      return `ui.pointer drag bar:${box.id} -> ${JSON.stringify(r)}`;
    },
    read: `/pg:${page}/c:${box.id}`, as: 'props',
    applied: v => v?.x === to.x && v?.y === to.y,
  });
});
