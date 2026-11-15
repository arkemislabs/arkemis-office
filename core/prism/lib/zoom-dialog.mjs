// The Insert Zoom dialogs: Slide Zoom, Section Zoom and Summary Zoom each list the slides (or sections) to zoom to.
// Translated from deckcraft crates/ui-egui/src/ribbon/view.rs (the Zoom popup: kind, checklist "N. title", and for sections
// "The presentation has no sections. Add one with Home > Section.") at 4ce2944. MIT, see
// assets/third-party-licenses/artcraft-reference.txt. No DOM, no Node built-ins.

import {defineDialog} from '../../kernel/dialog.mjs';
import {isSchema2} from '../model/doc.mjs';
import {slideTitle} from '../model/presentation.mjs';

const firstLine = t => String(t ?? '').split('\n')[0].trim();

export function zoomDialog(kind) {
  const ids = {slide: 'dialog.insertZoom', section: 'dialog.insertZoomSection', summary: 'dialog.insertZoomSummary'};
  const titles = {slide: 'Slide Zoom', section: 'Section Zoom', summary: 'Summary Zoom'};
  return defineDialog({
    id: ids[kind],
    title: titles[kind],
    command: 'insert.zoom',
    init(ctx) {
      const doc = isSchema2(ctx?.doc) ? ctx.doc : null;
      const slides = doc?.slides ?? [];
      const list = kind === 'section'
        ? (doc?.sections ?? []).map((sec, index) => ({index, title: sec.name || `Section ${index + 1}`}))
        : slides.map((sl, index) => ({index, title: firstLine(slideTitle(sl))}));
      // A summary starts with the first slide of every section checked.
      const picked = kind === 'summary'
        ? (doc?.sections ?? []).flatMap(sec => (sec.slides?.[0] ? [slides.findIndex(x => x.id === sec.slides[0])] : [])).filter(i => i >= 0)
        : [];
      return {kind, list, picked, empty: kind === 'section' && !list.length};
    },
    validate(v) {
      if (v.kind === 'section' && v.empty) return [{field: 'targets', message: 'The presentation has no sections. Add one with Home > Section.'}];
      return Array.isArray(v.picked) && v.picked.length ? [] : [{field: 'targets', message: kind === 'section' ? 'Check the sections to zoom to.' : 'Check the slides to zoom to.'}];
    },
    toCommand(v) {
      const picked = [...v.picked].sort((a, b) => a - b);
      return {command: 'insert.zoom', params: kind === 'section' ? {kind, sections: picked} : {kind, slides: picked}};
    },
  });
}
