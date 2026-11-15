// F:slate foundation benchmark (docs/architecture.md 19, phase 1): a notebook with 2,000 pages.
//
// The notebook: 20 sections of 100 pages; every page has a title, one note container with five
// paragraphs and three ink strokes of 50 points. What a person does in it, timed:
//
//   validate + index the notebook (opening it), switch pages, type 60 characters on a page (one
//   kernel command per keystroke, merged into one Undo Typing), undo that burst, add a page in the
//   middle of a 100-page section, find a word across all 2,000 pages, list a section, plan the
//   folder save after one keystroke (one page file is rewritten, nothing else), serialize the
//   whole notebook for New Notebook / Save a Copy.
//
// Measured on a development machine (Windows 11, Node 24), 2026-10-30:
//   validate + index all 2,000 bodies   60 ms      (again, cached: 4 ms)
//   open a session on it                 81 ms
//   switch to page 1,501                  8 ms
//   one keystroke (kernel command)        0.7 ms median, 1.6 ms p95
//   Undo Typing of a 60-key burst        54 ms
//   add a page mid-section                1.5 ms
//   find a word in all pages             24 ms      (more than 500 hits)
//   list a section / the notebook         0.4 ms / 0.8 ms
//   folder save plan after a keystroke    2.4 ms     (1 page file written)
//   serialize the whole notebook         58 ms      (2,022 files, 9.4 MB)
// The limits asserted are 10-25x those numbers (the full suite runs files in parallel on a busy
// machine: 4-5x slower was seen), so the test
// catches regressions (a change that copies the whole notebook per keystroke is 100x slower)
// without flaking.

import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplaceStep} from '@tiptap/pm/transform';
import {Slice, Fragment} from '@tiptap/pm/model';
import * as address from '../../core/slate/address.mjs';
import {planSave, serialize} from '../../core/slate/lib/notebook-folder.mjs';
import {model, notebookSession, probe, schema, seq, NOW} from './foundation-helpers.mjs';

const SECTIONS = 20, PER_SECTION = 100;
const WORDS = ['lecture', 'entropy', 'kinetic', 'momentum', 'vector', 'integral', 'derivative', 'theorem', 'proof', 'lemma', 'graph', 'network'];

function bigNotebook() {
  const uid = seq('q');
  const content = schema.createContent('Benchmark notebook', {uid, now: NOW});
  content.tree = []; content.sections = {}; content.pages = {};
  let n = 0;
  for (let s = 0; s < SECTIONS; s++) {
    const sid = `s${uid()}`;
    const entries = [];
    for (let p = 0; p < PER_SECTION; p++, n++) {
      const pid = `p${uid()}`;
      const paragraphs = Array.from({length: 5}, (_, k) => ({type: 'paragraph', attrs: {id: `b${uid()}`},
        content: [{type: 'text', text: `${WORDS[(n + k) % WORDS.length]} note ${n}.${k}: ${'lorem ipsum dolor sit amet '.repeat(2).trim()}`}]}));
      const body = {type: 'doc', content: [{type: 'container', attrs: {id: `c${uid()}`, x: 48, y: 128, width: 600}, content: paragraphs}]};
      const ink = Array.from({length: 3}, (_, k) => ({id: `k${uid()}`, tool: k === 2 ? 'highlighter' : 'pen', color: k === 2 ? '#ffff00' : '#000000', width: k === 2 ? 22.7 : 1.9,
        points: Array.from({length: 100}, (_, i) => (i % 2 ? 300 + k * 40 + Math.sin(i / 7) * 10 : 60 + i * 3))}));
      content.pages[pid] = {...schema.newPageRecord({id: pid, title: `Page ${n + 1} ${WORDS[n % WORDS.length]}`, created: NOW}), body, ink};
      entries.push({id: pid, level: p % 10 === 0 ? 0 : p % 10 < 5 ? 1 : 0});
    }
    content.sections[sid] = {id: sid, name: `Chapter ${s + 1}`, color: schema.SECTION_COLORS[s % 8], created: NOW, pages: entries};
    content.tree.push(sid);
  }
  return content;
}

const time = fn => { const t0 = performance.now(); const value = fn(); return {ms: performance.now() - t0, value}; };
const timeAsync = async fn => { const t0 = performance.now(); const value = await fn(); return {ms: performance.now() - t0, value}; };
const r1 = x => Math.round(x * 10) / 10;

test('2,000-page notebook: open, switch, type, undo, add a page, find, list, save plan (numbers in the header)', {timeout: 120_000}, async () => {
  const content = bigNotebook();
  assert.equal(Object.keys(content.pages).length, SECTIONS * PER_SECTION);
  const numbers = {};

  // Opening: validation parses and checks every page body once (cached afterwards).
  numbers.validate = time(() => schema.validateContent(content)).ms;
  numbers.revalidate = time(() => schema.validateContent(content)).ms;
  const addPage = await probe('probe.addPage', ctx => model.addPage(ctx, model.sectionOrder(ctx.doc)[10], {index: 50, title: 'Inserted'}));
  const opened = await timeAsync(() => notebookSession(content, {extra: [addPage]}));
  numbers.openSession = opened.ms;
  const t = opened.value;

  // Switching to the 1,500th page: where am I, its section's page list, its body parsed.
  const order = model.sectionOrder(t.content);
  const target = t.content.sections[order[15]].pages[0].id;
  numbers.switchPage = time(() => {
    t.session.setSelection(t.docId, model.selectPage(target), {origin: 'test'});
    const loc = model.currentLocation(t.content, t.doc.selection);
    const rows = model.pagesOf(t.content, loc.sectionId);
    schema.nodeOf(t.content.pages[loc.pageId].body);
    return rows.length;
  }).ms;

  // Typing 60 characters at the end of the page's first paragraph: one command per keystroke.
  const doc0 = schema.nodeOf(t.content.pages[target].body);
  const para = doc0.firstChild.firstChild;
  let pos = 2 + para.content.size;   // container start (1) + paragraph start (1) + its text
  const keys = [];
  for (let i = 0; i < 60; i++) {
    const step = new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.schema.text('x')), 0, 0)).toJSON();
    const k = await timeAsync(() => t.exec('surface.edit', {page: target, steps: [step], typing: true}));
    keys.push(k.ms);
    pos++;
  }
  keys.sort((a, b) => a - b);
  numbers.keystrokeMedian = keys[keys.length >> 1];
  numbers.keystrokeP95 = keys[Math.floor(keys.length * 0.95)];
  assert.match(t.read(`/pg:${target}/b:${para.attrs.id}`, 'text'), /x{60}$/);

  // One Undo Typing takes the whole burst back.
  numbers.undoBurst = (await timeAsync(() => t.undo())).ms;
  assert.doesNotMatch(t.read(`/pg:${target}/b:${para.attrs.id}`, 'text'), /x$/);

  // A page in the middle of a 100-page section.
  numbers.addPage = (await timeAsync(() => t.exec('probe.addPage'))).ms;
  assert.equal(t.content.sections[order[10]].pages[50].id !== undefined, true);

  // Find across every page title and paragraph.
  const found = time(() => address.find(t.content, {query: 'momentum', limit: 5000}));
  numbers.findAll = found.ms;
  assert.ok(found.value.matches.length > 500, `found ${found.value.matches.length}`);

  // Listing a section and the notebook's sections (document.inspect).
  numbers.listSection = time(() => address.enumerate(t.content, address.parse(`/sec:${order[3]}`), {depth: 1, limit: 200})).ms;
  numbers.listNotebook = time(() => address.enumerate(t.content, address.parse('/'), {depth: 2, limit: 3000})).ms;

  // Autosave into the notebook folder after one keystroke: one page file, nothing else.
  const before = t.content;
  const step = new ReplaceStep(3, 3, new Slice(Fragment.from(schema.schema.text('y')), 0, 0)).toJSON();
  await t.exec('surface.edit', {page: target, steps: [step]});
  const plan = time(() => planSave(before, t.content));
  numbers.planSaveOneKey = plan.ms;
  assert.equal(plan.value.writes.length, 1);
  assert.match(plan.value.writes[0].path, new RegExp(`/${target}\\.json$`));
  assert.equal(plan.value.moves.length + plan.value.mkdirs.length + plan.value.removes.length + plan.value.removeDirs.length, 0);

  // New Notebook / Save a Copy: every file of the notebook.
  const all = time(() => serialize(t.content));
  numbers.serializeAll = all.ms;
  numbers.files = all.value.size;
  numbers.megabytes = [...all.value.values()].reduce((n, s) => n + s.length, 0) / 1e6;
  assert.equal(all.value.size, 1 + SECTIONS + SECTIONS * PER_SECTION + 1);

  const report = Object.fromEntries(Object.entries(numbers).map(([k, v]) => [k, r1(v)]));
  console.log('slate 2,000-page benchmark (ms unless named):', JSON.stringify(report));

  // Limits: 10-25x the measured numbers in the header.
  assert.ok(numbers.validate < 1200, `validate ${numbers.validate}`);
  assert.ok(numbers.revalidate < 120, `revalidate ${numbers.revalidate}`);
  assert.ok(numbers.openSession < 1500, `open ${numbers.openSession}`);
  assert.ok(numbers.switchPage < 100, `switch ${numbers.switchPage}`);
  assert.ok(numbers.keystrokeMedian < 15, `keystroke median ${numbers.keystrokeMedian}`);
  assert.ok(numbers.keystrokeP95 < 60, `keystroke p95 ${numbers.keystrokeP95}`);
  assert.ok(numbers.undoBurst < 800, `undo ${numbers.undoBurst}`);
  assert.ok(numbers.addPage < 60, `add page ${numbers.addPage}`);
  assert.ok(numbers.findAll < 500, `find ${numbers.findAll}`);
  assert.ok(numbers.listSection < 30, `list section ${numbers.listSection}`);
  assert.ok(numbers.listNotebook < 60, `list notebook ${numbers.listNotebook}`);
  assert.ok(numbers.planSaveOneKey < 80, `plan save ${numbers.planSaveOneKey}`);
  assert.ok(numbers.serializeAll < 1200, `serialize ${numbers.serializeAll}`);
});
