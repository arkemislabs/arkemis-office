// New Tag / Modify Tag (Customize Tags › New Tag... / Modify Tag...; submit: tag.create or
// tag.modify). OneNote's dialog: Display name, Symbol, Font Color, Highlight Color and a preview
// of tagged text. Opened with init {mode: 'modify', tagId} it edits that tag. "Customize for
// Outlook tasks" is not offered: there is no Outlook to link to. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {TAG_SYMBOLS, findTag, tagList, tagIcon} from '../lib/tags-catalog.mjs';

/** "checkbox-red" -> "Check box red", "question-mark" -> "Question mark", "priority-1" -> "Priority 1". */
export const symbolLabel = s => (s === 'none' ? 'None' : s.replace(/^checkbox/, 'check box').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()));
export const SYMBOL_ITEMS = TAG_SYMBOLS.map(s => ({value: s, label: symbolLabel(s), icon: s === 'none' ? null : tagIcon({symbol: s})}));

const isColor = c => c === null || c === undefined || c === '' || /^#[0-9a-fA-F]{6}$/.test(String(c));

export default defineDialog({
  id: 'dialog.tag-editor',
  title: 'New Tag',
  titleFor: v => (v.mode === 'modify' ? 'Modify Tag' : 'New Tag'),
  command: 'tag.create',
  init: () => ({mode: 'new', tagId: null, displayName: '', symbol: 'none', fontColor: null, highlightColor: null, symbols: SYMBOL_ITEMS}),
  validate(v) {
    const out = [];
    const name = String(v.displayName ?? '').trim();
    if (!name) out.push({field: 'displayName', message: 'Type a display name for the tag.'});
    else if (name.length > 100) out.push({field: 'displayName', message: 'A display name has at most 100 characters.'});
    if (!TAG_SYMBOLS.includes(v.symbol ?? 'none')) out.push({field: 'symbol', message: 'Choose a symbol.'});
    if (!isColor(v.fontColor)) out.push({field: 'fontColor', message: 'Choose a font colour.'});
    if (!isColor(v.highlightColor)) out.push({field: 'highlightColor', message: 'Choose a highlight colour.'});
    return out;
  },
  preview: (ctx, v) => ({name: String(v.displayName ?? '').trim() || (v.mode === 'modify' ? findTag(ctx.prefs, v.tagId)?.name : '') || 'Tag',
    symbol: v.symbol ?? 'none', fontColor: v.fontColor || null, highlightColor: v.highlightColor || null,
    taken: tagList(ctx.prefs).filter(t => t.id !== v.tagId).map(t => t.name)}),
  toCommand(v) {
    const base = {displayName: String(v.displayName).trim(), symbol: v.symbol ?? 'none', fontColor: v.fontColor || null, highlightColor: v.highlightColor || null};
    return v.mode === 'modify' && v.tagId ? {command: 'tag.modify', params: {tagId: v.tagId, ...base}} : {command: 'tag.create', params: base};
  },
});
