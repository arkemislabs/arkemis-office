// Notebooks: File › New / Open, Close This Notebook, Notebook Properties and colour (U:slate/notebooks).
//
// Slate has no ArtCraft upstream: ids, args and summaries are docs/spec/slate.json `notebook.*`
// (sourceRef core/slate-notebooks.mjs); behaviour is OneNote's:
//   * File › New asks where the notebook lives (the system Save dialog titled "New Notebook";
//     the chosen name is the notebook's folder) and opens it with "New Section 1" and an untitled
//     page;
//   * File › Open (Ctrl+O) opens a notebook folder (the system folder dialog, or one from Recent
//     Notebooks); an already open notebook comes forward; problems reading pages are reported;
//   * Close This Notebook closes its window and keeps its files (every change is already saved
//     to the folder);
//   * Notebook Properties changes the display name and colour (the folder stays where it is).
// Disk access goes through the host's notebook service (design note
// integrator--slate-notebook--host-notebooks); headless and test hosts have none, so New and
// Open are disabled there with the reason.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {LIMITS, isNotebook} from '../schema.mjs';

const UPSTREAM = {repo: 'office', files: ['docs/spec/slate.json#commands/notebook.*', 'core/slate-notebooks.mjs']};
const NEED_DESKTOP = 'Notebooks on disk need the desktop app';
const need = (cond, code, message, data) => { if (!cond) throw new CommandError(code, message, data); };

const service = ctx => ctx.host?.notebooks ?? null;
const serviceState = ctx => (service(ctx) ? {enabled: true} : {enabled: false, reason: NEED_DESKTOP});
const notebookState = ctx => (isNotebook(ctx.doc) ? {enabled: true} : {enabled: false, reason: 'No notebook is open'});
const interactive = ctx => ctx.origin !== 'bridge' && ctx.origin !== 'test';

function checkNotebook(ctx, id) {
  need(isNotebook(ctx.doc), 'disabled', 'No notebook is open');
  if (id !== undefined) need(id === ctx.doc.notebook.id, 'not_found', `No notebook ${id} here`, {path: '/notebookId'});
}

export function checkNotebookName(name) {
  const n = String(name ?? '').trim();
  need(n.length >= 1 && n.length <= LIMITS.nameLength, 'invalid_params', `A notebook name has 1 to ${LIMITS.nameLength} characters`, {path: '/displayName'});
  need(!/[\\/:*?"<>|]/.test(n), 'invalid_params', 'A notebook name cannot contain any of these characters: / \\ : * ? " < > |', {path: '/displayName'});
  return n;
}

const colorParam = s.string({pattern: '^#[0-9a-fA-F]{6}$', description: '#RRGGBB'});

export default defineCommands({
  family: 'notebooks',
  app: 'slate',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'notebook.new', label: 'New', risk: 'edit', effect: 'persist', undo: 'none', scope: 'app', dialog: 'dialog.new-notebook',
      description: 'Create a notebook in a new folder (the system dialog asks where) and open it.',
      params: s.object({
        name: s.optional(s.string({min: 1, max: 100, trim: true, description: 'Notebook name (the folder name)'})),
        location: s.optional(s.string({min: 1, max: 4096, description: 'Folder the notebook folder is created in (default: ask)'})),
      }),
      state: serviceState,
      async run(ctx, p) {
        const nb = service(ctx);
        need(nb, 'disabled', NEED_DESKTOP);
        const name = p.name === undefined ? undefined : checkNotebookName(p.name);
        const opts = {show: interactive(ctx) || ctx.origin === 'bridge', ...(name ? {name} : {})};
        if (p.location) opts.path = name ? `${p.location.replace(/[\\/]+$/, '')}/${name}` : p.location;
        const r = await nb.create('new', opts);
        if (!r) return {cancelled: true};
        return {doc: r.doc, path: r.path, name: r.name};
      },
    },
    {
      id: 'notebook.open', label: 'Open', shortcut: 'Mod+O', risk: 'edit', effect: 'persist', undo: 'none', scope: 'app',
      description: 'Open a notebook folder (the system folder dialog, or a path from Recent Notebooks); an open notebook comes forward.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096}))}),
      state: serviceState,
      async run(ctx, p) {
        const nb = service(ctx);
        need(nb, 'disabled', NEED_DESKTOP);
        const r = await nb.create('open', {...(p.path ? {path: p.path} : {}), show: true});
        if (!r) return {cancelled: true};
        return {doc: r.doc, path: r.path, name: r.name, alreadyOpen: !!r.alreadyOpen, warnings: r.warnings ?? []};
      },
    },
    {
      id: 'notebook.close', label: 'Close This Notebook', risk: 'edit', effect: 'persist', undo: 'none',
      description: 'Close the notebook\'s window; its folder and files stay where they are.',
      params: s.object({notebookId: s.optional(s.string({min: 1, max: 200}))}),
      state: ctx => (!isNotebook(ctx.doc) ? {enabled: false, reason: 'No notebook is open'} : typeof ctx.host?.close === 'function' ? {enabled: true} : {enabled: false, reason: NEED_DESKTOP}),
      async run(ctx, p) {
        checkNotebook(ctx, p.notebookId);
        need(typeof ctx.host.close === 'function', 'disabled', NEED_DESKTOP);
        await ctx.host.close(ctx.docId, {discard: false});
        return {closed: ctx.doc.notebook.id};
      },
    },
    {
      id: 'notebook.properties', label: 'Properties', risk: 'edit', dialog: 'dialog.notebook-properties',
      description: 'Change the notebook\'s display name and colour.',
      params: s.object({
        notebookId: s.optional(s.string({min: 1, max: 200})),
        displayName: s.optional(s.string({min: 1, max: 100, trim: true})),
        color: s.optional(colorParam),
      }),
      state(ctx) {
        const st = notebookState(ctx);
        return st.enabled ? {enabled: true, value: {displayName: ctx.doc.notebook.name, color: ctx.doc.notebook.color, path: ctx.doc.notebook.path ?? null}} : st;
      },
      run(ctx, p) {
        checkNotebook(ctx, p.notebookId);
        const changed = [];
        if (p.displayName !== undefined) {
          const name = checkNotebookName(p.displayName);
          if (name !== ctx.doc.notebook.name) { ctx.change.set(['notebook', 'name'], name); ctx.change.setMeta?.('title', name); changed.push('displayName'); }
        }
        if (p.color !== undefined && p.color.toLowerCase() !== (ctx.doc.notebook.color ?? '').toLowerCase()) {
          ctx.change.set(['notebook', 'color'], p.color.toLowerCase());
          changed.push('color');
        }
        return {notebook: ctx.doc.notebook.id, displayName: ctx.doc.notebook.name, color: ctx.doc.notebook.color, changed};
      },
    },
    {
      id: 'notebook.setColor', label: 'Notebook Color', risk: 'edit',
      description: 'Set the notebook\'s colour (shown on its icon in the notebook list).',
      params: s.object({notebookId: s.optional(s.string({min: 1, max: 200})), color: colorParam}),
      state(ctx, p) {
        const st = notebookState(ctx);
        if (!st.enabled) return st;
        return {enabled: true, value: ctx.doc.notebook.color, ...(p?.color ? {checked: ctx.doc.notebook.color === p.color.toLowerCase()} : {})};
      },
      run(ctx, p) {
        checkNotebook(ctx, p.notebookId);
        const color = p.color.toLowerCase();
        if (ctx.doc.notebook.color === color) return {color, changed: false};
        ctx.change.set(['notebook', 'color'], color);
        return {color, changed: true};
      },
    },
  ],
});

