// Home › Slides › Section › Collapse All / Expand All, and a section header's own arrow: which sections
// of the slide pane are folded shut. Folding is view state (nothing in the presentation changes and
// nothing is undoable); the thumbnail pane leaves a folded section's slides out under its header.
// deckcraft's thumbnail pane has no folding, so this follows PowerPoint ("not checked against upstream").

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {isSchema2} from '../model/doc.mjs';
import {bad} from '../lib/text-session.mjs';

/** A section's key in the folded list: its first slide's id, else its name. */
export const sectionKey = sec => String(sec?.slides?.[0] ?? sec?.name ?? '');
const sections = ctx => (isSchema2(ctx.doc) ? ctx.doc.sections ?? [] : []);
const state = ctx => (!isSchema2(ctx.doc) ? {enabled: false, reason: 'no presentation open'} : sections(ctx).length ? {enabled: true} : {enabled: false, reason: 'the presentation has no sections'});
const folded = ctx => (Array.isArray(ctx.view?.foldedSections) ? ctx.view.foldedSections : []);

export default defineCommands({
  family: 'section_fold',
  app: 'prism',
  upstream: {repo: 'office', files: ['PowerPoint Home › Slides › Section']},
  commands: [
    {id: 'section.collapseAll', label: 'Collapse All', risk: 'read', effect: 'view', state, params: s.object({}),
      description: 'Fold every section of the slide pane shut.',
      run(ctx) { if (!sections(ctx).length) throw bad('section.collapseAll', 'the presentation has no sections'); ctx.setView({foldedSections: sections(ctx).map(sectionKey)}); return {folded: sections(ctx).length}; }},
    {id: 'section.expandAll', label: 'Expand All', risk: 'read', effect: 'view', state, params: s.object({}),
      description: 'Open every section of the slide pane.',
      run(ctx) { ctx.setView({foldedSections: []}); return {folded: 0}; }},
    {id: 'section.toggleFold', label: 'Collapse Section', risk: 'read', effect: 'view', state, params: s.object({index: s.integer({min: 0}), on: s.optional(s.boolean())}),
      description: '{index, on?: bool} fold or open one section (default: toggle).',
      run(ctx, p) {
        const sec = sections(ctx)[p.index];
        if (!sec) throw bad('section.toggleFold', 'no such section', {path: '/index'});
        const key = sectionKey(sec), cur = folded(ctx), on = p.on ?? !cur.includes(key);
        ctx.setView({foldedSections: on ? [...new Set([...cur, key])] : cur.filter(k => k !== key)});
        return {index: p.index, folded: on};
      }},
  ],
});
