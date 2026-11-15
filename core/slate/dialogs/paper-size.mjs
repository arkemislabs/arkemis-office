// Paper Size pane (View › Page Setup › Paper Size; submit: page.paperSize). OneNote's pane: Size
// (Auto, Statement, Letter, ... Envelope C5), Orientation, Width and Height, Print Margins Top /
// Bottom / Left / Right in inches; "Save current page as a template" opens Save As Template.
// Changing Size or Orientation fills Width and Height. Slate has no ArtCraft upstream.
import {defineDialog} from '../../kernel/dialog.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {DEFAULT_MARGINS, PAPER_SIZES} from '../commands/pages.mjs';

function dims(size, orientation) {
  const d = PAPER_SIZES[size];
  if (!d) return {width: null, height: null};
  return orientation === 'Landscape' ? {width: d[1], height: d[0]} : {width: d[0], height: d[1]};
}

export default defineDialog({
  id: 'dialog.paper-size',
  title: 'Paper Size',
  command: 'page.paperSize',
  init(ctx) {
    const {pageId} = currentLocation(ctx.doc, ctx.selection);
    const ps = pageId ? ctx.doc.pages[pageId].paperSize : null;
    const m = ps?.margins ?? DEFAULT_MARGINS;
    return {size: ps?.size ?? 'Auto', orientation: ps?.orientation === 'landscape' ? 'Landscape' : 'Portrait', width: ps?.width ?? null, height: ps?.height ?? null,
      marginTop: m.top, marginBottom: m.bottom, marginLeft: m.left, marginRight: m.right};
  },
  derive: (v, changed) => (changed.includes('size') || changed.includes('orientation') ? dims(v.size, v.orientation) : {}),
  validate(v) {
    const out = [];
    if (!(v.size in PAPER_SIZES)) out.push({field: 'size', message: 'Choose a paper size.'});
    if (v.size !== 'Auto') {
      for (const k of ['width', 'height']) if (!(Number(v[k]) >= 1 && Number(v[k]) <= 100)) out.push({field: k, message: 'Enter a size from 1 to 100 inches.'});
      for (const k of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight']) if (!(Number(v[k]) >= 0 && Number(v[k]) <= 20)) out.push({field: k, message: 'Enter a margin from 0 to 20 inches.'});
    }
    return out;
  },
  toCommand(v) {
    if (v.size === 'Auto') return {command: 'page.paperSize', params: {size: 'Auto'}};
    return {command: 'page.paperSize', params: {size: v.size, orientation: v.orientation === 'Landscape' ? 'landscape' : 'portrait', width: Number(v.width), height: Number(v.height),
      margins: {top: Number(v.marginTop), bottom: Number(v.marginBottom), left: Number(v.marginLeft), right: Number(v.marginRight)}}};
  },
});
