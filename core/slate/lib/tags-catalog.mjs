// Note tags: OneNote's default tag gallery, the tag definitions a person keeps, and the tag record
// a tagged paragraph carries (U:slate/tags; other units may import, not edit).
//
// Slate has no ArtCraft upstream. The gallery is docs/spec/slate.json `home.tags.tags.*` (29
// tags in OneNote's order; the first nine get Ctrl+1..Ctrl+9). As in OneNote:
//   * the tag list is the person's (Customize Tags edits it for every notebook): prefs
//     `slate.tags` holds it once customised, otherwise the defaults apply;
//   * a tagged paragraph keeps a copy of the tag's look, so modifying or removing a tag later
//     leaves existing tagged notes as they were ("existing tagged notes keep the old look");
//   * checkbox tags (To Do and the other check box symbols) carry a checked state.
//
// Paragraph `tags` attr: [{id, name, symbol, fontColor, highlightColor, checkbox, checked, created}].
//
// No DOM, no Node built-ins.

/** Symbols the tag editor offers (dialog.tag-editor › Symbol), checkbox symbols first. */
export const TAG_SYMBOLS = Object.freeze([
  'none',
  'checkbox', 'checkbox-red', 'checkbox-orange', 'checkbox-yellow', 'checkbox-green', 'checkbox-blue', 'checkbox-purple', 'checkbox-gray', 'checkbox-1', 'checkbox-2',
  'checkbox-client', 'checkbox-people-a', 'checkbox-people-b', 'checkbox-people-manager', 'checkbox-calendar', 'checkbox-phone-back',
  'star', 'star-blue', 'star-green', 'question-mark', 'question-mark-blue', 'flag-red', 'flag-yellow', 'flag-green', 'flag-blue', 'arrow-right', 'arrow-left',
  'priority-1', 'priority-2', 'priority-3', 'people', 'lightbulb', 'key', 'phone', 'house', 'envelope', 'calendar', 'clock', 'book', 'music-note', 'film',
  'pen', 'globe', 'exclamation', 'person-card', 'document', 'highlighter',
]);
export const isCheckboxSymbol = symbol => typeof symbol === 'string' && symbol.startsWith('checkbox');

const tag = (id, name, symbol, fontColor = null, highlightColor = null) => Object.freeze({id, name, symbol, fontColor, highlightColor});

/** OneNote's default tags in gallery order. */
export const DEFAULT_TAGS = Object.freeze([
  tag('to-do', 'To Do', 'checkbox'),
  tag('important', 'Important', 'star'),
  tag('question', 'Question', 'question-mark'),
  tag('remember-for-later', 'Remember for later', 'none', null, '#ffff00'),
  tag('definition', 'Definition', 'none', null, '#00ff00'),
  tag('highlight', 'Highlight', 'highlighter'),
  tag('contact', 'Contact', 'person-card'),
  tag('address', 'Address', 'house'),
  tag('phone-number', 'Phone number', 'phone'),
  tag('web-site-to-visit', 'Web site to visit', 'globe'),
  tag('idea', 'Idea', 'lightbulb'),
  tag('password', 'Password', 'key'),
  tag('critical', 'Critical', 'exclamation'),
  tag('project-a', 'Project A', 'flag-red'),
  tag('project-b', 'Project B', 'flag-yellow'),
  tag('movie-to-see', 'Movie to see', 'film'),
  tag('book-to-read', 'Book to read', 'book'),
  tag('music-to-listen-to', 'Music to listen to', 'music-note'),
  tag('source-for-article', 'Source for article', 'document'),
  tag('remember-for-blog', 'Remember for blog', 'pen'),
  tag('discuss-with-person-a', 'Discuss with <Person A>', 'checkbox-people-a'),
  tag('discuss-with-person-b', 'Discuss with <Person B>', 'checkbox-people-b'),
  tag('discuss-with-manager', 'Discuss with manager', 'checkbox-people-manager'),
  tag('send-in-email', 'Send in email', 'envelope'),
  tag('schedule-meeting', 'Schedule meeting', 'checkbox-calendar'),
  tag('call-back', 'Call back', 'checkbox-phone-back'),
  tag('to-do-priority-1', 'To Do priority 1', 'checkbox-1'),
  tag('to-do-priority-2', 'To Do priority 2', 'checkbox-2'),
  tag('client-request', 'Client request', 'checkbox-client'),
]);

/** The icon (assets/icons/ribbon/tag-*.svg) that draws a tag's gallery tile, from its symbol and highlight. */
export function tagIcon(def) {
  const sym = String(def?.symbol ?? 'none');
  if (sym === 'none') {
    const c = String(def?.highlightColor ?? '').toLowerCase();
    return c === '#00ff00' || c === '#92d050' ? 'tag-highlight-green' : c ? 'tag-highlight-yellow' : 'tag-highlighter';
  }
  const known = {'checkbox-1': 'tag-checkbox-1', 'checkbox-2': 'tag-checkbox-2', 'checkbox-client': 'tag-checkbox-client', 'checkbox-people-a': 'tag-people-a', 'checkbox-people-b': 'tag-people-b',
    'checkbox-people-manager': 'tag-people-manager', 'checkbox-calendar': 'tag-calendar', 'checkbox-phone-back': 'tag-phone-back', 'flag-red': 'tag-flag-red', 'flag-yellow': 'tag-flag-yellow',
    people: 'tag-people-a', clock: 'tag-calendar', 'arrow-right': 'tag-star', 'arrow-left': 'tag-star', 'priority-1': 'tag-exclamation', 'priority-2': 'tag-exclamation', 'priority-3': 'tag-exclamation'};
  if (known[sym]) return known[sym];
  if (sym.startsWith('checkbox')) return 'tag-checkbox';
  if (sym.startsWith('star')) return 'tag-star';
  if (sym.startsWith('question-mark')) return 'tag-question-mark';
  if (sym.startsWith('flag')) return 'tag-flag-red';
  return `tag-${sym}`;
}

export const MAX_TAGS = 200;
export const PREF = 'slate.tags';

/** The person's tag list (gallery order). */
export function tagList(prefs) {
  const list = prefs?.[PREF];
  return Array.isArray(list) && list.every(t => t && typeof t.id === 'string' && typeof t.name === 'string') ? list : DEFAULT_TAGS;
}

export const findTag = (prefs, id) => tagList(prefs).find(t => t.id === id) ?? null;

/** The record a paragraph carries for a tag (a copy of its look). */
export const tagRecord = (def, created) => ({id: def.id, name: def.name, symbol: def.symbol, fontColor: def.fontColor ?? null,
  highlightColor: def.highlightColor ?? null, checkbox: isCheckboxSymbol(def.symbol), checked: false, created});
