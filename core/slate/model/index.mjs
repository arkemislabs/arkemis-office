// Slate's foundation API (`ctx.model` in every Slate command; docs/architecture.md 5.1 and 16.5).
//
//   ctx.model.current(ctx)                      -> {sectionId, pageId} of the selection
//   ctx.model.addPage(ctx, sectionId, {...})    -> new page id (undoable)
//   ctx.model.applySteps(ctx, pageId, steps)    -> ProseMirror steps on a page (undoable, maps the caret)
//   ctx.model.insertContainer(ctx, pageId, {x, y, text})
//   ctx.model.addStroke(ctx, pageId, stroke)
//
// Slate has no ArtCraft upstream: the model follows docs/spec/slate.json `dataModel` and OneNote.
// No DOM, no Node built-ins.

import {isNotebook} from '../schema.mjs';
import {currentLocation} from './notebook.mjs';

export * from './notebook.mjs';
export * from './page.mjs';
export * from './canvas.mjs';
export * from './styles.mjs';
export {schema, nodeOf, jsonOf, isNotebook, createContent, newPageRecord, NOTEBOOK_FORMAT, SECTION_COLORS, NOTEBOOK_COLORS,
  PARAGRAPH_STYLES, RULE_PATTERNS, DEFAULT_RULE_COLOR, MAX_LEVEL, LIMITS} from '../schema.mjs';

/** The page and section the command acts on (the selection's). */
export const current = ctx => currentLocation(ctx.doc, ctx.selection);

/** State helper for notebook commands: enabled when a Slate notebook (schema 2) is open. */
export const notebookState = ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'});

/** State helper for page commands: enabled when there is a current page. */
export function pageState(ctx) {
  if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
  return current(ctx).pageId ? {enabled: true} : {enabled: false, reason: 'No page is open'};
}
