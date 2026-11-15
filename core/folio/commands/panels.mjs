// The rail's Layers, Attachments and Tags panels: the toggles, what each lists, and what they change (a layer's visibility, deleting or saving an
// attachment).
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/chrome.rs:560-575          the rail's items: Layers (shown for a document with layers), Attachments (with attachments), Tags
//   crates/ui-egui/src/panels/right.rs            the panels' rows; a layer row toggles its eye; Save attachment…; delete for an attachment of the
//                                                 document itself; "This document has no layers", "…no attachments"
//   crates/engine/src/layers.rs                   a layer's visibility written to the default configuration
// The panes are src/apps/folio/panes/{layers,attachments,tags}.tsx; they read through layers.read, attachments.read and tags.read and write
// through the commands here. Attach a file (edit.attach) belongs to Edit. A layer's visibility is written into the document (one undo step), so
// the page view follows it; upstream keeps it as view state.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/panels.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {pagesOf} from '../lib/comment-geometry.mjs';
import {loadSource, editable, commit} from '../lib/page-source.mjs';
import {readLayers, writeLayerState, readAttachments, attachmentBytes, removeAttachment, readTags} from '../lib/pdf-info.mjs';
import {writeOther, writeState, interactive} from '../lib/page-files.mjs';
import {modification} from '../lib/edit-needs.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/chrome.rs', 'crates/ui-egui/src/panels/right.rs', 'crates/engine/src/layers.rs', 'crates/ui-egui/src/tools/tags_ui.rs']};
const noPdf = {enabled: false, reason: 'no PDF open'};
const documentState = ctx => (pagesOf(ctx).length ? {enabled: true} : noPdf);

const toggle = (id, label, panel, description) => ({
  id, label, risk: 'read', effect: 'view', undo: 'none', description,
  params: s.object({open: s.optional(s.boolean())}),
  state: ctx => ({...documentState(ctx), checked: ctx.view?.rightPanel === panel}),
  run(ctx, p) {
    const open = p.open ?? ctx.view?.rightPanel !== panel;
    ctx.setView({rightPanel: open ? panel : null, ...(open ? {panel: null} : {})});
    return {panel: open ? panel : null};
  },
});

export default defineCommands({
  family: 'panels',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    toggle('layers.panel', 'Layers', 'layers', 'Show or hide the Layers panel in the right rail (the document\'s layers with an eye each); default: toggle.'),
    toggle('attachments.panel', 'Attachments', 'attachments', 'Show or hide the Attachments panel in the right rail (the files attached to the document and to its comments); default: toggle.'),
    toggle('a11y.tags', 'Tags', 'tags', 'Show or hide the Tags panel in the right rail (the document\'s structure tree); default: toggle.'),
    {
      id: 'layers.read', label: 'Layers', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'The document\'s layers (optional content groups) in the order the file lists them: id, name and whether each shows.',
      params: s.object({}), state: documentState,
      async run(ctx) { return {layers: readLayers(await loadSource(ctx.doc))}; },
    },
    {
      id: 'layers.set', label: 'Show or hide a layer', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Show or hide a layer (`id` from layers.read; `visible` omitted toggles it): the document\'s default layer state is rewritten (/BaseState /ON, /ON, /OFF), so the pages and a saved copy show it so. One undo step.',
      params: s.object({id: s.string({min: 1, max: 40}), visible: s.optional(s.boolean())}),
      state: modification,
      async run(ctx, p) {
        const {doc, content} = await editable(ctx.doc, []);
        const layer = readLayers(doc).find(l => l.id === p.id);
        if (!layer) throw new CommandError('not_found', `there is no layer ${p.id}`, {path: '/id'});
        const visible = p.visible ?? !layer.visible;
        if (!writeLayerState(doc, {[layer.id]: visible})) throw new CommandError('disabled', 'this document has no layers');
        await commit(ctx, doc, content);
        ctx.setUndoLabel(visible ? 'Show layer' : 'Hide layer');
        return {id: layer.id, name: layer.name, visible};
      },
    },
    {
      id: 'attachments.read', label: 'Attachments', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'The files attached to the document and to its comments: key, name, size, description and where it is (the document, or a page).',
      params: s.object({}), state: documentState,
      async run(ctx) { return {attachments: readAttachments(await loadSource(ctx.doc))}; },
    },
    {
      id: 'attachments.save', label: 'Save attachment…', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Save an attachment (`key` from attachments.read) to `path`, or from the window to the file picked in the system Save dialog (named as the attachment); a program without a path gets the file as base64.',
      params: s.object({key: s.string({min: 1, max: 600}), path: s.optional(s.string({min: 1, max: 4096}))}),
      state: both(documentState, writeState),
      async run(ctx, p) {
        const f = attachmentBytes(await loadSource(ctx.doc), p.key);
        if (!f) throw new CommandError('not_found', `there is no attachment ${p.key}`, {path: '/key'});
        const out = await writeOther(ctx, {path: p.path}, f.bytes, {title: 'Save attachment', name: f.name.replace(/[\\/:*?"<>|]/g, '_') || 'attachment', filters: [{name: 'All Files (*.*)', extensions: ['*']}]});
        if (out.canceled) return {canceled: true};
        return {...out, name: f.name, size: f.bytes.length};
      },
    },
    {
      id: 'attachments.delete', label: 'Delete attachment', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Delete an attachment of the document itself (`key` "doc:…" from attachments.read); the files comments carry are deleted with their comments. One undo step.',
      params: s.object({key: s.string({min: 1, max: 600})}),
      state: modification,
      async run(ctx, p) {
        if (!p.key.startsWith('doc:')) throw new CommandError('invalid_params', 'only an attachment of the document itself can be deleted here; delete the comment that carries the file', {path: '/key'});
        const {doc, content} = await editable(ctx.doc, []);
        if (!readAttachments(doc).some(a => a.key === p.key)) throw new CommandError('not_found', `there is no attachment ${p.key}`, {path: '/key'});
        removeAttachment(doc, p.key);
        await commit(ctx, doc, content);
        ctx.setUndoLabel('Delete attachment');
        return {deleted: p.key};
      },
    },
    {
      id: 'tags.read', label: 'Tags', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'The document\'s structure tree (tagged PDF): each element by its tag, its title (/Alt, /ActualText or /T) and page, with its children; empty for an untagged document.',
      params: s.object({}), state: documentState,
      async run(ctx) { return {tags: readTags(await loadSource(ctx.doc))}; },
    },
  ],
});

function both(a, b) { return ctx => { const x = a(ctx); return x.enabled ? b(ctx) : x; }; }
void interactive;
