// Shared setup for the Slate foundation tests (F:slate): a schema-2 notebook session with the
// generated Slate commands plus the canvas commands (src/apps/slate/ui-commands/surface.ts).
// Slate has no ArtCraft upstream, so there are no Rust tests to port (tests/slate/upstream stays
// empty); behaviour is checked against OneNote's, as each test title says.

import {createTestSession} from '../../core/kernel/testing.mjs';
import {modules, sources} from '../../core/generated/slate.commands.mjs';
import surface from '../../src/apps/slate/ui-commands/surface.ts';
import * as schemaModule from '../../core/slate/schema.mjs';
import * as addressModule from '../../core/slate/address.mjs';
import * as contextModule from '../../core/slate/context.mjs';
import * as migrateModule from '../../core/slate/migrate.mjs';
import * as modelModule from '../../core/slate/model/index.mjs';

// The Slate foundation as core/generated/apps.mjs lists it, imported directly so these tests do
// not depend on the other apps' foundations (apps.mjs imports all five).
export const foundation = {schema: schemaModule, address: addressModule, context: contextModule, migrate: migrateModule, model: modelModule};
export const model = foundation.model;
export const schema = foundation.schema;

/** Deterministic ids and clock for content built outside a session. */
export function seq(prefix = 'x') {
  let n = 0;
  return () => `${prefix}${(n++).toString(36).padStart(4, '0')}`;
}
export const NOW = '2026-10-29T12:00:00.000Z';

export function notebookFile(content, id = 'nb-doc') {
  return {id, schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content};
}

/** A notebook: sections [{name, pages: [title | {title, level}]}], optional groups [{name, sections: [...]}]. */
export function buildNotebook({name = 'Course notes', sections = [{name: 'Week 1', pages: ['Lecture 1']}], groups = []} = {}) {
  const uid = seq('i');
  const content = schema.createContent(name, {uid, now: NOW});
  // Start from an empty notebook and add what the test asks for.
  content.tree = []; content.sections = {}; content.pages = {};
  let color = 0;
  const addSection = (s, into) => {
    const sid = `s${uid()}`;
    const entries = [];
    for (const p of s.pages) {
      const page = typeof p === 'string' ? {title: p, level: 0} : p;
      const pid = `p${uid()}`;
      content.pages[pid] = schema.newPageRecord({id: pid, title: page.title, created: NOW});
      entries.push({id: pid, level: page.level ?? 0});
    }
    content.sections[sid] = {id: sid, name: s.name, color: schema.SECTION_COLORS[color++ % 8], created: NOW, pages: entries};
    into.push(sid);
    return sid;
  };
  for (const s of sections) addSection(s, content.tree);
  for (const g of groups) {
    const gid = `g${uid()}`;
    content.groups[gid] = {id: gid, name: g.name, created: NOW, items: []};
    content.tree.push(gid);
    for (const s of g.sections) addSection(s, content.groups[gid].items);
  }
  return schema.validateContent(content);
}

/** A test session on a notebook; `extra` adds command families (probes that call the model). */
export async function notebookSession(content = buildNotebook(), {extra = [], ...opts} = {}) {
  return createTestSession('slate', {file: notebookFile(content), modules: [...modules, surface, ...extra],
    sources: [...sources, 'src/apps/slate/ui-commands/surface.ts', ...extra.map(f => `probe:${f.family}`)], foundation, ...opts});
}

/** A one-command family for tests that drive the model directly. */
export async function probe(id, run) {
  const {defineCommands} = await import('../../core/kernel/command.mjs');
  const {s} = await import('../../core/kernel/schema.mjs');
  return defineCommands({family: `probe-${id.replace(/\W/g, '')}`, app: 'slate', upstream: {repo: 'office', files: []},
    commands: [{id, label: 'Probe', risk: 'edit', params: s.object({}), run}]});
}

export const firstPage = t => {
  const sid = model.sectionOrder(t.content)[0];
  return t.content.sections[sid].pages[0].id;
};
