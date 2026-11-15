// F:slate foundation: a notebook is a folder on disk (core/slate/lib/notebook-folder.mjs).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. OneNote: File › New › Notebook asks where the notebook goes and creates a folder there; the
//    folder holds the table of contents, one file per section and a subfolder per section group.
//    There is no Save: every change is saved into those files as it is made. Renaming a section
//    renames its file; File › Open › Notebook opens such a folder.
// 2. Ours: the same folder shape with standard JSON (notebook.json, <Section>/section.json, one
//    <pageId>.json per page so autosave rewrites only the page that changed); renames move the
//    folder; opening reads the folder back to the same notebook. The folder pickers are the
//    integrator's (design note F-slate--integrator--notebook-folders).
// 3. Proof: these tests run against a real temporary folder through node:fs, the adapter the main
//    process will use.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ReplaceStep} from '@tiptap/pm/transform';
import {Slice, Fragment} from '@tiptap/pm/model';
import {folderLayout, loadNotebook, planSave, safeName, saveNotebook, writeNotebook, NOTEBOOK_FILE, SECTION_FILE} from '../../core/slate/lib/notebook-folder.mjs';
import {buildNotebook, model, notebookSession, probe, schema} from './foundation-helpers.mjs';

/** FolderFs over node:fs (atomic writes through a temporary file). */
const nodeFs = {
  readText: p => fs.readFile(p, 'utf8'),
  async writeText(p, text) { const tmp = `${p}.${process.pid}.tmp`; await fs.writeFile(tmp, text); await fs.rename(tmp, p); },
  list: async p => (await fs.readdir(p, {withFileTypes: true})).map(d => ({name: d.name, dir: d.isDirectory()})),
  mkdir: p => fs.mkdir(p, {recursive: true}).then(() => {}),
  rename: (a, b) => fs.rename(a, b),
  remove: p => fs.rm(p, {recursive: true, force: true}),
};

async function tempRoot(name = 'Course notes') {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-folder-'));
  return {base, root: path.join(base, name).split(path.sep).join('/')};
}

const tree = async dir => {
  const out = [];
  const walk = async (d, rel) => {
    for (const e of await fs.readdir(d, {withFileTypes: true})) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(`${r}/`); await walk(path.join(d, e.name), r); } else out.push(r);
    }
  };
  await walk(dir, '');
  return out.sort();
};

const sample = () => buildNotebook({sections: [{name: 'Week 1', pages: ['Monday', {title: 'Lab', level: 1}]}, {name: 'Week 2', pages: ['Tuesday']}],
  groups: [{name: 'Archive', sections: [{name: 'Old: notes?', pages: ['Agenda']}]}]});

test('New Notebook: the folder holds notebook.json, a folder per section and group, one file per page; Open Notebook reads it back', async () => {
  const {base, root} = await tempRoot();
  try {
    const content = sample();
    const r = await writeNotebook(nodeFs, root, content);
    assert.equal(r.written, 1 + 3 + 4 + 1);
    const pages = id => content.sections[id].pages.map(e => `${e.id}.json`);
    const [w1, w2, g] = content.tree;
    const old = content.groups[g].items[0];
    assert.deepEqual(await tree(root), [
      'Archive/', 'Archive/Old_ notes_/', ...['group.json'].map(f => `Archive/${f}`),
      ...[SECTION_FILE, ...pages(old)].map(f => `Archive/Old_ notes_/${f}`),
      'Week 1/', ...[SECTION_FILE, ...pages(w1)].map(f => `Week 1/${f}`),
      'Week 2/', ...[SECTION_FILE, ...pages(w2)].map(f => `Week 2/${f}`),
      NOTEBOOK_FILE,
    ].sort());
    const {content: back, warnings} = await loadNotebook(nodeFs, root);
    assert.deepEqual(warnings, []);
    assert.equal(back.notebook.path, root);
    assert.deepEqual({...back, notebook: {...back.notebook, path: null}}, content);
  } finally { await fs.rm(base, {recursive: true, force: true}); }
});

test('autosave writes only what changed: one keystroke rewrites one page file; a rename moves the section folder', async () => {
  const {base, root} = await tempRoot();
  try {
    const content = sample();
    await writeNotebook(nodeFs, root, content);
    const t = await notebookSession(content);
    const [w1] = content.tree;
    const mon = content.sections[w1].pages[0].id;
    // The session holds its own copy: compare versions of that copy (records keep identity).
    let prev = t.content;
    const ins = await t.exec('surface.newContainer', {page: mon, x: 60, y: 140, text: 'Hello'});
    assert.ok(ins.result.container);
    let plan = planSave(prev, t.content);
    assert.deepEqual(plan.writes.map(w => w.path), [`Week 1/${mon}.json`]);
    await saveNotebook(nodeFs, root, prev, t.content);
    prev = t.content;
    const page = JSON.parse(await fs.readFile(path.join(root, 'Week 1', `${mon}.json`), 'utf8'));
    assert.equal(schema.nodeOf(page.body).textContent, 'Hello');

    // Typing one more character: still one file.
    const doc = schema.nodeOf(t.content.pages[mon].body);
    const step = new ReplaceStep(doc.content.size - 2, doc.content.size - 2, new Slice(Fragment.from(schema.schema.text('!')), 0, 0)).toJSON();
    await t.exec('surface.edit', {page: mon, steps: [step]});
    plan = planSave(prev, t.content);
    assert.equal(plan.writes.length, 1);
    await saveNotebook(nodeFs, root, prev, t.content);
    prev = t.content;

    // Renaming Week 1 (a model edit, as section.rename will make): the folder moves, pages ride along.
    const rename = await probe('probe.rename', ctx => { ctx.change.set(['sections', w1, 'name'], 'Week One'); });
    const t2 = await notebookSession(t.content, {extra: [rename]});
    await t2.exec('probe.rename');
    plan = planSave(prev, t2.content);
    assert.deepEqual(plan.moves.map(m => [m.from, m.to]), [['Week 1', 'Week One']]);
    await saveNotebook(nodeFs, root, prev, t2.content);
    const files = await tree(root);
    assert.ok(files.includes(`Week One/${mon}.json`));
    assert.ok(!files.some(f => f.startsWith('Week 1/')));
    assert.ok(!files.some(f => f.startsWith('.slate-moving')));
    const {content: back} = await loadNotebook(nodeFs, root);
    assert.equal(back.sections[w1].name, 'Week One');
    assert.equal(schema.nodeOf(back.pages[mon].body).textContent, 'Hello!');
  } finally { await fs.rm(base, {recursive: true, force: true}); }
});

test('pages moved between sections and deleted pages leave their old files; new sections get folders', async () => {
  const {base, root} = await tempRoot();
  try {
    const content = sample();
    await writeNotebook(nodeFs, root, content);
    const [w1, w2] = content.tree;
    const [mon, lab] = content.sections[w1].pages.map(e => e.id);
    const edit = await probe('probe.reorg', ctx => {
      ctx.model.removePage(ctx, lab);
      const at = ctx.model.pageIndex(ctx.doc).get(mon);
      ctx.change.splice(['sections', w1, 'pages'], at.index, 1);
      ctx.change.splice(['sections', w2, 'pages'], 0, 0, {id: mon, level: 0});
      ctx.model.addSection(ctx, {id: 'snew', name: 'Week 3'});
    });
    const t = await notebookSession(content, {extra: [edit]});
    await t.exec('probe.reorg');
    await saveNotebook(nodeFs, root, content, t.content);
    const files = await tree(root);
    assert.ok(!files.includes(`Week 1/${mon}.json`) && !files.includes(`Week 1/${lab}.json`));
    assert.ok(files.includes(`Week 2/${mon}.json`));
    assert.ok(files.includes('Week 3/section.json'));
    const {content: back, warnings} = await loadNotebook(nodeFs, root);
    assert.deepEqual(warnings, []);
    assert.deepEqual(back.sections[w2].pages.map(e => e.id), t.content.sections[w2].pages.map(e => e.id));
    assert.deepEqual(back.tree, t.content.tree);
  } finally { await fs.rm(base, {recursive: true, force: true}); }
});

test('Open Notebook tolerates a missing page file and a page file copied in; refuses a folder that is not a notebook', async () => {
  const {base, root} = await tempRoot();
  try {
    const content = sample();
    await writeNotebook(nodeFs, root, content);
    const [w1, w2] = content.tree;
    const [mon] = content.sections[w1].pages.map(e => e.id);
    const tue = content.sections[w2].pages[0].id;
    await fs.rm(path.join(root, 'Week 1', `${mon}.json`));
    const stray = {...schema.newPageRecord({id: 'pstray', title: 'Copied in', created: content.pages[tue].created})};
    await fs.writeFile(path.join(root, 'Week 2', 'pstray.json'), JSON.stringify(stray));
    const {content: back, warnings} = await loadNotebook(nodeFs, root);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /missing/);
    assert.ok(!back.pages[mon]);
    assert.deepEqual(back.sections[w2].pages.map(e => e.id), [tue, 'pstray']);
    await assert.rejects(loadNotebook(nodeFs, base), /not a Slate notebook/);
  } finally { await fs.rm(base, {recursive: true, force: true}); }
});

test('folder names are safe on every platform and unique per parent', () => {
  assert.equal(safeName('a/b:c*'), 'a_b_c_');
  assert.equal(safeName('CON'), 'CON_');
  assert.equal(safeName('notes. '), 'notes');
  assert.equal(safeName('.hidden'), '_hidden');
  const c = buildNotebook({sections: [{name: 'Notes', pages: []}, {name: 'notes?', pages: []}]});
  // Two names that clean up to the same folder get "(2)".
  c.sections[c.tree[1]].name = 'NOTES';
  const dirs = [...folderLayout(c).values()].map(d => d.dir);
  assert.deepEqual(dirs, ['Notes', 'NOTES (2)']);
  assert.equal(model.sectionOrder(c).length, 2);
});
