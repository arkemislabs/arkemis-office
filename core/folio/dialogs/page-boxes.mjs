// Set Page Boxes (submit: page.boxes): the box (CropBox, TrimBox, BleedBox, ArtBox, MediaBox), units,
// margins Top/Bottom/Left/Right from the media box (Set to zero), pages All / Current page / From–to.
// Translated from printcraft crates/ui-egui/src/dialogs/pageboxes.rs:91 (the margins start from the
// current page's box, in the chosen units) at 3109bb2359759e24ef490e1cdbdba00722b20972.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {currentPage} from '../commands/page.mjs';

const BOX = {CropBox: 'crop', TrimBox: 'trim', BleedBox: 'bleed', ArtBox: 'art', MediaBox: 'media'};
const PER = {pt: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54};
const round = (v, unit) => Math.round((v / PER[unit]) * (unit === 'pt' ? 1 : 1000)) / (unit === 'pt' ? 1 : 1000);

export default defineDialog({
  id: 'dialog.page-boxes',
  title: 'Set Page Boxes',
  command: 'page.boxes',
  init(ctx) {
    const list = ctx.doc?.pages ?? [];
    const i = currentPage(ctx);
    const pg = list[i];
    // The crop box's margins inside the page's media size as the model knows it (box relative to 0,0).
    const box = Array.isArray(pg?.box) ? pg.box : [0, 0, pg?.width ?? 612, pg?.height ?? 792];
    const media = pg?.media ?? [0, 0, (box[2] - box[0]) + box[0], (box[3] - box[1]) + box[1]];
    return {box: 'CropBox', units: 'pt', top: Math.max(0, media[3] - box[3]), bottom: Math.max(0, box[1] - media[1]), left: Math.max(0, box[0] - media[0]),
      right: Math.max(0, media[2] - box[2]), pages: 'All', from: 1, to: Math.max(1, list.length), __count: list.length, __current: i + 1, __unit: 'pt'};
  },
  derive(v, changed) {
    if (changed.includes('units') && v.units in PER && v.__unit in PER) {
      const k = PER[v.__unit];
      const out = {__unit: v.units};
      for (const f of ['top', 'bottom', 'left', 'right']) out[f] = round((Number(v[f]) || 0) * k, v.units);
      return out;
    }
    if (changed.includes('zero')) return {top: 0, bottom: 0, left: 0, right: 0};
    return {};
  },
  validate(v) {
    const out = [];
    for (const f of ['top', 'bottom', 'left', 'right']) if (!(Number(v[f]) >= 0)) out.push({field: f, message: 'Margins are zero or more'});
    if (v.pages === 'From') {
      const n = Number(v.__count) || 1, a = Number(v.from), b = Number(v.to);
      if (!(Number.isInteger(a) && a >= 1 && a <= n)) out.push({field: 'from', message: `Type a page number from 1 to ${n}`});
      else if (!(Number.isInteger(b) && b >= a && b <= n)) out.push({field: 'to', message: `Type a page number from ${a} to ${n}`});
    }
    return out;
  },
  toCommand(v) {
    const k = PER[v.units] ?? 1;
    const pt = f => (Number(v[f]) || 0) * k;
    const which = v.pages === 'From' ? 'range' : v.pages === 'All' ? 'all' : 'current';
    return {command: 'page.boxes', params: {box: BOX[v.box] ?? 'crop', margins: [pt('left'), pt('bottom'), pt('right'), pt('top')], which,
      ...(which === 'range' ? {from: Number(v.from), to: Number(v.to)} : {})}};
  },
});
