// Quill skeleton: format.bold from the bridge on a text selection of a schema-2 document, read
// back, undone, then Home › Font › Bold from the ribbon; capture to artifacts/skeleton/quill.png.
//
// What wordcraft does: format.bold toggles bold on the selected runs as one undo step
// (crates/engine/src/cmd/format.rs). What Word does: the same, and the ribbon's Bold shows checked
// while the selection is bold. What this proves: the bridge, the ribbon and undo reach the same
// schema-2 command in the new shell (the seed is converted with core/quill/migrate.mjs, as the host
// converts an older document when it opens it).
import test from 'node:test';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/quill/migrate.mjs';
import {runSkeleton} from '../skeleton.mjs';

test('quill skeleton: format.bold through the bridge and the ribbon, with undo', {timeout: 200_000}, async () => {
  const old = createFile('quill', 'Skeleton document');
  old.id = 'quill-skeleton';
  old.content.doc = {type: 'doc', content: [
    {type: 'paragraph', content: [{type: 'text', text: 'Hello world from the Quill skeleton.'}]},
    {type: 'paragraph', content: [{type: 'text', text: 'A second paragraph stays as it is.'}]},
  ]};
  const seed = migrateFile(old);
  const first = seed.content.body.chunks[0][0].id;
  const bold = runs => JSON.stringify(runs ?? null).includes('"bold":true');
  await runSkeleton({
    app: 'quill', seed, tab: 'home',
    setup: ({app, doc}) => app.rpc('selection.set', {doc, ranges: [{anchor: `/body/b:${first}/t:0`, focus: `/body/b:${first}/t:5`}]}),
    command: 'format.bold', params: {}, undoLabel: 'Automation: Bold',
    control: 'home.font.bold', checked: true,
    read: `/body/b:${first}`, as: 'runs',
    applied: bold,
  });
});
