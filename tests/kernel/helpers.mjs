// Shared fixtures for kernel tests: a small "list" command family over generic JSON content.
import {defineCommands} from '../../core/kernel/command.mjs';
import {s} from '../../core/kernel/schema.mjs';
import {CommandError} from '../../core/kernel/errors.mjs';

export const listFamily = defineCommands({
  family: 'list',
  app: ['quill', 'grid', 'prism', 'folio', 'slate'],
  upstream: {repo: 'office', files: []},
  commands: [
    {id: 'list.push', label: 'Push', risk: 'edit', params: s.object({value: s.string()}),
      run(ctx, p) { ctx.change.splice('items', ctx.doc.items.length, 0, p.value); return {length: ctx.doc.items.length}; }},
    {id: 'list.remove', label: 'Remove', risk: 'edit', params: s.object({index: s.integer({min: 0})}),
      state: ctx => (ctx.doc.items.length ? {enabled: true} : {enabled: false, reason: 'the list is empty'}),
      run(ctx, p) {
        if (p.index >= ctx.doc.items.length) throw new CommandError('invalid_params', 'index is past the end', {path: '/index'});
        ctx.change.splice('items', p.index, 1);
      }},
    {id: 'list.set', label: 'Set Item', risk: 'edit', params: s.object({index: s.integer({min: 0}), value: s.string()}),
      run(ctx, p) { ctx.change.set(['items', p.index], p.value); }},
    {id: 'list.title', label: 'Set Title', risk: 'edit', params: s.object({title: s.string()}),
      run(ctx, p) { ctx.change.set('meta/title', p.title); }},
    {id: 'list.select', label: 'Select Item', risk: 'read', params: s.object({index: s.integer({min: 0})}),
      run(ctx, p) { ctx.setSelection({ranges: [{anchor: `/items/${p.index}`, focus: `/items/${p.index}`}], primary: 0}); }},
    {id: 'list.pushThenFail', label: 'Push Then Fail', risk: 'edit', params: s.object({}),
      run(ctx) { ctx.change.splice('items', 0, 0, 'zzz'); throw new Error('boom'); }},
    {id: 'list.pushTwice', label: 'Push Twice', risk: 'edit', params: s.object({value: s.string()}),
      run(ctx, p) { ctx.run('list.push', {value: p.value}); ctx.run('list.push', {value: p.value}); }},
    {id: 'list.clear', label: 'Clear List', risk: 'destructive', params: s.object({}),
      summary: ctx => `Remove all ${ctx.doc.items.length} items`,
      run(ctx) { ctx.change.splice('items', 0, ctx.doc.items.length); }},
    {id: 'list.publish', label: 'Publish', risk: 'irreversible', params: s.object({to: s.string()}),
      summary: (ctx, p) => `Publish the list to ${p.to}`,
      run: (ctx, p) => ({published: p.to})},
    {id: 'list.lieAboutUndo', label: 'Lie', risk: 'edit', effect: 'view', undo: 'none', params: s.object({}),
      run(ctx) { ctx.change.set('meta/title', 'sneaky'); }},
    {id: 'list.slow', label: 'Slow Push', risk: 'edit', params: s.object({value: s.string(), ms: s.integer({min: 0})}),
      async run(ctx, p) { await new Promise(r => setTimeout(r, p.ms)); ctx.change.splice('items', ctx.doc.items.length, 0, p.value); }},
  ],
});

export const listContent = () => ({items: ['a', 'b', 'c', 'd'], meta: {title: 'List'}});
export const appInfo = {app: 'quill', tabs: ['Home', 'Insert', 'View'], contextualTabs: ['Table Design'], qat: ['file.save', 'edit.undo', 'edit.redo']};
