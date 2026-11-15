// Undo, Redo, Undo Actions, Undo History and Repeat for every app.
// Translated from wordcraft crates/engine/src/cmd/edit.rs (edit.undo, edit.undoTo, edit.undoHistory,
// edit.redo) and crates/engine/src/cmd/tools/specs.rs (edit.repeat) at
// aadb077e072b7de05f724e359d8db82e151f125c (spec pin 3de6ff95af86c19d67030cd96dba15cd6a45a25e).
// Gridcraft and Slate name the count `steps`, wordcraft's Undo Actions names it `count`: both are
// accepted. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';

const steps = s.optional(s.integer({min: 1, max: 1000, description: 'How many steps (default 1)'}));
const nothingToUndo = {enabled: false, reason: 'there is nothing to undo'};
const nothingToRedo = {enabled: false, reason: 'there is nothing to redo'};

export default defineCommands({
  family: 'edit',
  app: '*',
  upstream: {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c',
    files: ['crates/engine/src/cmd/edit.rs', 'crates/engine/src/cmd/tools/specs.rs']},
  commands: [
    {
      id: 'edit.undo', label: 'Undo', shortcut: 'Mod+Z', risk: 'edit', repeatable: false,
      description: 'Undo the last change (or the last `steps` changes).',
      params: s.object({steps}),
      state: ctx => (ctx.history.canUndo ? {enabled: true, value: ctx.history.undoLabels()[0]} : nothingToUndo),
      run(ctx, p) { ctx.history.undo(p.steps ?? 1); },
    },
    {
      id: 'edit.redo', label: 'Redo', shortcut: ['Mod+Y', 'Mod+Shift+Z'], risk: 'edit', repeatable: false,
      description: 'Redo the last undone change (or the last `steps` of them).',
      params: s.object({steps}),
      state: ctx => (ctx.history.canRedo ? {enabled: true, value: ctx.history.redoLabels()[0]} : nothingToRedo),
      run(ctx, p) { ctx.history.redo(p.steps ?? 1); },
    },
    {
      id: 'edit.undoTo', label: 'Undo Actions', risk: 'edit', repeatable: false,
      description: 'Undo the newest `count` steps at once (1 = like Undo; at most the undo depth).',
      params: s.object({count: s.integer({min: 1, max: 1000, description: '1 = the newest step'})}),
      // The Undo arrow's list (QAT): one entry per undo step, newest first; choosing one undoes it and everything above it.
      state: ctx => (ctx.history.canUndo ? {enabled: true, value: ctx.history.undoLabels().slice(0, 100).map((label, i) => ({id: i, label, value: i + 1}))} : nothingToUndo),
      run(ctx, p) {
        const undone = ctx.history.undo(p.count);
        return {undone, depth: ctx.history.undoDepth - undone};
      },
    },
    {
      id: 'edit.undoHistory', label: 'Undo History', risk: 'read',
      description: 'The labels on the undo list, newest first, and the next redo.',
      params: s.object({}),
      run: ctx => ({undo: ctx.history.undoLabels(), depth: ctx.history.undoDepth, redo: ctx.history.redoLabels()[0] ?? null}),
    },
    {
      id: 'edit.repeat', label: 'Repeat', shortcut: 'F4', risk: 'edit', repeatable: false,
      description: 'Run the last command again with the same parameters on the current selection.',
      params: s.object({}),
      state: ctx => (ctx.history.lastCommand ? {enabled: true, value: ctx.registry.get(ctx.history.lastCommand.command)?.label}
        : {enabled: false, reason: 'nothing to repeat'}),
      run(ctx) {
        const last = ctx.history.lastCommand;
        if (!last) throw new CommandError('failed', 'nothing to repeat');
        const label = ctx.registry.get(last.command)?.label;
        if (label) ctx.setUndoLabel(label);
        return ctx.run(last.command, last.params);
      },
    },
  ],
});
