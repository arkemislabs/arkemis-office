// Change reading options (submit: a11y.reading_options.apply): the document Language, the Title, whether the window shows the title (Initial View > Show:
// Document Title) and the tab order (Use Document Structure). Upstream opens Document Properties on its Advanced tab (printcraft a11y_ui.rs `PanelAction::Fix`);
// this app's Document Properties dialog has no such tab, so the options are here. Not checked against upstream.

import {defineDialog} from '../../kernel/dialog.mjs';

/** The dialog's values as a11y.reading_options params. */
export const readingOf = v => ({language: String(v.language ?? '').trim(), title: String(v.title ?? '').trim(), displayTitle: v.displayTitle === true, tabOrder: v.tabOrder === true});

export default defineDialog({
  id: 'dialog.reading-options',
  title: 'Reading Options',
  command: 'a11y.reading_options.apply',
  init: () => ({language: '', title: '', displayTitle: true, tabOrder: true}),
  validate(v) {
    const l = String(v.language ?? '').trim();
    return l && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(l) ? [{field: 'language', message: 'A language is a tag such as en, en-US or ar'}] : [];
  },
  toCommand: v => ({command: 'a11y.reading_options.apply', params: readingOf(v)}),
});
