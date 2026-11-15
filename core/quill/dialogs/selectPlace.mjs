// Insert Hyperlink › Bookmark…: Word's Select Place in Document box. The top of the document, its headings and its bookmarks to pick one
// from; OK gives the place back to the Insert Hyperlink dialog (it runs no command of its own).

import {defineDialog} from '../../kernel/dialog.mjs';
import {placesOf} from './link.mjs';

export default defineDialog({
  id: 'dialog.selectPlace',
  title: 'Select Place in Document',
  init: ctx => ({place: null, places: placesOf(ctx)}),
  validate: v => (v.place ? [] : [{field: 'place', message: 'Choose a place in this document.'}]),
  toCommand: () => ({command: 'insert.link', params: {top: true}}),
});
