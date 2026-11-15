// Customize Tags (Home › Tags › Customize Tags...). OneNote's dialog: All Tags in gallery order
// (the first nine show Ctrl+1..9), Move tag up / down, New Tag..., Modify Tag..., Remove tag;
// each button changes the tag list at once and OK closes. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {tagList, tagIcon} from '../lib/tags-catalog.mjs';

const has = (ctx, id) => tagList(ctx.prefs).some(t => t.id === id);

export default defineDialog({
  id: 'dialog.customize-tags',
  title: 'Customize Tags',
  command: 'tag.reorder',
  init(ctx) {
    const list = tagList(ctx.prefs);
    // `list` is what the All Tags rows draw: the tag's name with its icon and, for the first nine, its Ctrl+n.
    return {tags: list[0]?.id ?? null, list: list.map((t, i) => ({...t, value: t.id, label: t.name, icon: tagIcon(t), detail: i < 9 ? `Ctrl+${i + 1}` : null, shortcut: i < 9 ? `Ctrl+${i + 1}` : null}))};
  },
  validate: () => [],
  buttons: {
    moveUp: (ctx, v) => (has(ctx, v.tags) ? {command: 'tag.reorder', params: {tagId: v.tags, direction: 'up'}} : null),
    moveDown: (ctx, v) => (has(ctx, v.tags) ? {command: 'tag.reorder', params: {tagId: v.tags, direction: 'down'}} : null),
    removeTag: (ctx, v) => (has(ctx, v.tags) ? {command: 'tag.delete', params: {tagId: v.tags}} : null),
  },
  // Every change is applied by its button; OK reads the final list.
  toCommand: () => ({command: 'tag.customize', params: {}}),
});
