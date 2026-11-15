// "<Kind> Properties" (Comment Properties): Appearance (icon, colour, fill, font size, opacity,
// thickness, line endings, locked), General (author, subject, modified) and Review History.
//
// Translated from printcraft crates/ui-egui/src/dialogs/comment_props.rs (what each comment kind
// shows: icon for notes, fill for rectangles/ovals/polygons/text boxes, font size for text boxes,
// endings for lines and connected lines; Make Properties Default) and crates/annot/src/info.rs
// `props` at 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. OK runs annot.properties (one undo step);
// Make Properties Default runs it with makeDefault. Acrobat's border style (dashed, cloudy) is not
// in upstream and stays hidden.

import {defineDialog} from '../../kernel/dialog.mjs';
import {props} from '../model/annots.mjs';
import {commentAt, hexOf} from '../lib/comment-geometry.mjs';
import {commentThreads, kindLabel} from '../lib/comment-panel.mjs';
import {summaries} from '../model/annots.mjs';

const ENDINGS = ['None', 'Square', 'Circle', 'Diamond', 'OpenArrow', 'ClosedArrow', 'Butt', 'ROpenArrow', 'RClosedArrow', 'Slash'];
const ENDING_LABELS = ['None', 'Square', 'Circle', 'Diamond', 'Open arrow', 'Closed arrow', 'Butt', 'Reverse open arrow', 'Reverse closed arrow', 'Slash'];
const toEnding = label => ENDINGS[Math.max(0, ENDING_LABELS.indexOf(label))] ?? label;

export default defineDialog({
  id: 'dialog.comment-properties',
  title: 'Properties',
  command: 'comment.properties',
  init(ctx, args = {}) {
    const t = commentAt(ctx, args?.annotation);
    const p = props(t.record);
    const s = summaries(ctx.doc).find(x => x.id === t.record.id);
    const thread = commentThreads(ctx.doc).roots.find(r => r.comment.id === t.record.id);
    const ends = p.endings ?? [];
    return {
      annotation: `/pg:${encodeURIComponent(t.page.id)}/annot:${encodeURIComponent(t.record.id)}`, kind: s ? kindLabel(s) : p.subtype,
      icon: p.icon, color: hexOf(p.color), fill: hexOf(p.fill), 'font-size': p.fontSize, opacity: Math.round((p.opacity ?? 1) * 100), thickness: p.width,
      'line-start': ends.length === 2 ? ENDING_LABELS[ENDINGS.indexOf(ends[0])] : null, 'line-end': ends.length === 2 ? ENDING_LABELS[ENDINGS.indexOf(ends[1])] : ends.length === 1 ? ENDING_LABELS[ENDINGS.indexOf(ends[0])] : null,
      locked: p.locked, author: p.author, subject: p.subject, modified: p.modified ?? '',
      history: (thread?.history ?? []).map(h => `${h.state} — ${h.author ?? ''} ${h.modified ?? ''}`.trim()),
      fillable: p.fillable, restylable: p.restylable, subtype: p.subtype, makeDefault: false,
      initial: {color: hexOf(p.color), fill: hexOf(p.fill), opacity: Math.round((p.opacity ?? 1) * 100), thickness: p.width, 'font-size': p.fontSize, icon: p.icon, author: p.author, subject: p.subject, locked: p.locked},
    };
  },
  validate(v) {
    const out = [];
    if (v.opacity != null && !(v.opacity >= 0 && v.opacity <= 100)) out.push({field: 'opacity', message: 'Opacity is 0–100 %.'});
    if (v.thickness != null && !(v.thickness >= 0 && v.thickness <= 12)) out.push({field: 'thickness', message: 'Thickness is 0–12 pt.'});
    if (v['font-size'] != null && !(v['font-size'] >= 1 && v['font-size'] <= 400)) out.push({field: 'font-size', message: 'Font size is 1–400 pt.'});
    return out;
  },
  buttons: {
    'Make Properties Default': (ctx, v) => ({command: 'comment.properties', params: {annotation: v.annotation, makeDefault: true}}),
  },
  toCommand(v) {
    const i = v.initial ?? {};
    const p = {annotation: v.annotation};
    if (v.color && v.color !== i.color) p.color = v.color;
    if (v.fillable && v.fill !== i.fill) p.fill = v.fill || null;
    if (v.opacity != null && v.opacity !== i.opacity) p.opacity = v.opacity / 100;
    if (v.thickness != null && v.thickness !== i.thickness) p.width = v.thickness;
    if (v['font-size'] != null && v['font-size'] !== i['font-size']) p.fontSize = v['font-size'];
    if (v.subtype === 'Text' && v.icon && v.icon !== i.icon) p.icon = v.icon;
    if (['Line', 'PolyLine'].includes(v.subtype)) { if (v['line-start']) p.start = toEnding(v['line-start']); if (v['line-end']) p.end = toEnding(v['line-end']); }
    if (v.author !== i.author) p.author = v.author ?? '';
    if (v.subject !== i.subject) p.subject = v.subject ?? '';
    if (!!v.locked !== !!i.locked) p.locked = !!v.locked;
    if (v.makeDefault) p.makeDefault = true;
    return {command: 'comment.properties', params: p};
  },
});
