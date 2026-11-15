// Grid skeleton: edit.fillDown from the bridge on /sh:sh1/A1:A2 of a schema-2 workbook, read back,
// undone, then Ctrl+D through KeyRouter on the selection; capture to artifacts/skeleton/grid.png.
//
// What gridcraft does: edit.fillDown copies the top row of the selection into the rows below as
// one undo step (crates/engine/src/cmd/edit/fill.rs), bound to Ctrl+D (ribbon/shortcuts.rs). What
// Excel does: the same. What this proves: the bridge, the shortcut table and undo reach the same
// schema-2 command in the new shell. (Home › Bold is written against schema 1 until the format
// family moves: design note F-grid--format--schema2-cells.)
import test from 'node:test';
import {createFile} from '../../../core/model.mjs';
import {migrateFile} from '../../../core/grid/migrate.mjs';
import {runSkeleton} from '../skeleton.mjs';

test('grid skeleton: edit.fillDown through the bridge and Ctrl+D, with undo', {timeout: 200_000}, async () => {
  const old = createFile('grid', 'Skeleton workbook');
  old.id = 'grid-skeleton';
  const sheet = old.content.sheets[0];
  sheet.id = 'sh1';
  old.content.activeSheetId = 'sh1';
  sheet.cells = {A1: {value: 'Revenue'}, B1: {value: '1200'}, A2: {value: 'Costs'}, B2: {value: '800'}};
  const seed = migrateFile(old);
  await runSkeleton({
    app: 'grid', seed, tab: 'home',
    setup: ({app, doc}) => app.rpc('selection.set', {doc, ranges: [{anchor: '/sh:sh1/A1', focus: '/sh:sh1/A2'}]}),
    command: 'edit.fillDown', params: {range: '/sh:sh1/A1:A2'}, undoLabel: 'Automation: Fill Down',
    keys: 'Ctrl+D',
    read: '/sh:sh1/A2',
    applied: v => v?.cells?.A2?.value === 'Revenue',
  });
});
