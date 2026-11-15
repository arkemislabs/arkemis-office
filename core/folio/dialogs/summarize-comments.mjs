// Summarize Options: Comments only, sorted by Page, Author, Date or Type ▸ Create PDF Comment Summary.
//
// Translated from printcraft crates/ui-egui/src/dialogs.rs:1208 (dialog_summarize_comments: the one
// layout upstream draws, "Comments only", and the sort combo of SummarySort::ALL) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Acrobat's other three layouts (document and comments with connector lines / sequence numbers),
// "Include" and "Font Size" are not in upstream and stay hidden (docs/spec/patches/folio/comment.json).

import {defineDialog} from '../../kernel/dialog.mjs';
import {SUMMARY_SORTS} from '../lib/comment-pdf.mjs';

export default defineDialog({
  id: 'dialog.summarize-comments',
  title: 'Summarize Options',
  command: 'comment.summarize',
  init: ctx => ({layout: 'Comments only', sort: ctx.prefs?.summarySort ?? 'Page'}),
  validate: v => (SUMMARY_SORTS.includes(v.sort) ? [] : [{field: 'sort', message: 'Choose how to sort the comments.'}]),
  toCommand: v => ({command: 'comment.summarize', params: {sort: v.sort}}),
});
