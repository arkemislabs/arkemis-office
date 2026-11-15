// Edit: cut, copy and paste (text, shapes and slides; rich text from other apps), Paste Special
// (Use Destination Theme, Keep Source Formatting, Keep Text Only), Paste and Match Formatting,
// Duplicate, Delete, Select All, Deselect and Select Objects.
// Translated from deckcraft crates/engine/src/cmd/edit.rs (`specs`, `slides_scope`, `copy_inner`,
// `copying_caret`, `copy`, `copied_html`, `cut`, `paste`, `paste_external_body`, `paste_plain`,
// `paste_special`, `paste_text`, `duplicate`, `delete`, `select_all`, `select_all_slides`,
// `deselect`, `select`) and crates/engine/src/cmd/insert.rs (`new_text_box`, `text_box`,
// `add_shape`, `first_free_name`, the text box `edit.paste` makes when no text is being edited)
// at f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The clipboard: copy writes plain text and HTML to the system clipboard through the Host and keeps
// deckcraft's `Clipboard` (text body, shapes with their media and source theme, or slides) in the
// session (core/common/lib/clipboard.mjs), kinds `prism.text`, `prism.shapes`, `prism.slides`.
// Paste uses ours while the system clipboard still holds what we copied, else the other app's
// text (with its HTML formatting when it says the same words). deckcraft's paste counter (each
// paste of the same shapes on their slide steps further) and last Duplicate (Ctrl+D repeats the
// distance the copies were moved) are view state `pasteCount` and `lastDuplicate`.
// Edit.undo/redo are the kernel's (core/common/commands/edit.mjs).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {writeClipboard, readClipboard} from '../../common/lib/clipboard.mjs';
import {textSelection, slideById, slidePath, xfrmOf, masterFor} from '../model/doc.mjs';
import {findShape, walk, layoutById, presetGeom, shape as newShape, slideTitle} from '../model/presentation.mjs';
import {bodyText, bodyFromText} from '../model/text.mjs';
import {textRange, slice} from '../model/edit.mjs';
import {
  bad, hasDoc, hasSlide, hasSelection, selectionOf, bodyOf, textPositions, ordered, samePos, targets, currentNames, idsParam, idOf,
  selectShapeIds, selectSlideList, fitTextBox, UPSTREAM_COMMIT,
} from '../lib/text-session.mjs';
import {reid, remapAnimations, removeShapes, mediaRefs, remapMedia, bringMedia, bakeTheme, sourceTheme, takeId} from '../lib/edit-shapes.mjs';
import {bodyToHtml, htmlToBody, sameWords} from '../lib/edit-richclip.mjs';
import {insertText, pasteBody, deleteDir} from './text.mjs';
import {cellsOnClipboard, pasteCells, pastesIntoTable, pasteTextCells} from '../lib/table-clip.mjs';
import {cellSelection} from '../lib/table-sel.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/edit.rs', 'crates/engine/src/cmd/richclip.rs', 'crates/engine/src/cmd/insert.rs']};

const shapeId = s.union([s.string({min: 1, max: 64}), s.integer({min: 0, max: 4294967295})]);
const scope = s.optional(s.enum(['slides'], {description: '`slides`: act on the slides selected in the slide list'}));
const AS = ['destinationTheme', 'useDestinationTheme', 'keepSource', 'keepSourceFormatting', 'text', 'keepTextOnly'];

const duplicateOffset = ctx => {
  const v = ctx.prefs?.prism?.duplicateOffset;
  return Number.isFinite(v) ? Math.min(Math.max(v, -1000), 1000) : 12;
};
const clip = ctx => (ctx.clipboard && ctx.clipboard.app === 'prism' ? ctx.clipboard : null);

/** deckcraft `slides_scope`. */
function slidesScope(ctx, p) {
  if (p?.scope === 'slides') return true;
  const sel = selectionOf(ctx);
  return !sel.shapes.length && !sel.text && sel.slides.length > 0;
}

/** deckcraft `copy_inner`: what is copied, as a session clipboard entry ({text, html, kind, data}) or null (a caret copies nothing). */
function copyInner(ctx, p) {
  const c = ctx.doc;
  const sel = selectionOf(ctx);
  if (sel.text) {
    const body = bodyOf(c, sel.text);
    const {anchor, caret} = textPositions(body ?? {paragraphs: []}, sel.text);
    if (!body || samePos(anchor, caret)) return null;
    const [a, b] = ordered(anchor, caret);
    const plain = textRange(body, a, b);
    const sliced = slice(body, a, b);
    return {text: plain, html: bodyToHtml(sliced), kind: 'prism.text', data: {text: sliced, plain}};
  }
  if (slidesScope(ctx, p)) {
    const ids = sel.slides.length ? sel.slides : sel.slideId ? [sel.slideId] : [];
    const slides = ids.map(id => slideById(c, id)).filter(Boolean).map(x => structuredClone(x));
    const mids = new Set();
    for (const sl of slides) for (const m of mediaRefs(sl)) mids.add(m);
    const media = (c.media ?? []).filter(m => mids.has(String(m.id))).map(m => structuredClone(m));
    const plain = slides.map(slideTitle).join('\n');
    return {text: plain, html: '', kind: 'prism.slides', data: {slides, media, plain}};
  }
  // Selected table cells copy as cells (with their formatting) and as their text: a tab between cells and a paragraph per row.
  const cells = p?.id === undefined && p?.ids === undefined ? cellsOnClipboard(ctx) : null;
  if (cells) return {text: cells.plain, html: '', kind: 'prism.cells', data: cells};
  const shapes = sel.shapes.map(id => findShape(sel.slide?.shapes, id)).filter(Boolean).map(sh => {
    const x = structuredClone(sh);
    if (!x.xfrm) x.xfrm = xfrmOf(c, sel.slideId, sh);
    return x;
  });
  const mids = mediaRefs(shapes);
  const media = (c.media ?? []).filter(m => mids.has(String(m.id))).map(m => structuredClone(m));
  const plain = shapes.filter(x => x.text).map(x => bodyText(x.text)).join('\n');
  const paragraphs = shapes.flatMap(x => x.text?.paragraphs ?? []);
  const html = paragraphs.length ? bodyToHtml({body: {}, paragraphs}) : '';
  const ml = sel.slide ? masterFor(c, sel.slide) : null;
  return {text: plain, html, kind: 'prism.shapes', data: {shapes, media, plain, slideId: sel.slideId, sourceTheme: sourceTheme(ml?.[0])}};
}

/** Copy: put the entry on the clipboard; `{text, html}` as deckcraft returns. */
async function copy(ctx, p) {
  const e = copyInner(ctx, p);
  if (!e) return {text: '', html: ''};
  await writeClipboard(ctx, {text: e.text, html: e.html, kind: e.kind, data: e.data});
  return {text: e.text, html: e.html};
}

/** deckcraft insert.rs `text_box` (with `new_text_box` and `add_shape`): a text box holding `text` on the current slide. */
function addTextBox(ctx, cmd, rect, text) {
  if (ctx.registry?.has?.('insert.textBox')) return ctx.run('insert.textBox', {rect, text});
  const sel = selectionOf(ctx);
  const sp = slidePath(ctx.doc, sel.slideId);
  if (!sp) throw bad(cmd, 'no slide');
  const holder = {pres: ctx.doc};
  const id = takeId(holder, cmd);
  const taken = currentNames(sel.slide);
  let n = taken.size + 1;
  while (taken.has(`TextBox ${n}`)) n += 1;
  const body = bodyFromText(text);
  const sh = newShape({id, name: `TextBox ${n}`, xfrm: {x: rect[0], y: rect[1], w: Math.abs(rect[2]), h: Math.abs(rect[3])}, textBox: true, fill: null,
    geom: presetGeom('rect'), text: {...body, body: {wrap: true, autofit: {kind: 'shape'}}}});
  ctx.change.set(['nextId'], holder.pres.nextId);
  ctx.change.splice([...sp, 'shapes'], sel.slide.shapes.length, 0, sh);
  fitTextBox(ctx, sel.slideId, id, ctx.host);
  selectShapeIds(ctx, sel.slideId, [id]);
  return {id};
}
const pasteRect = c => [c.slideSize.width * 0.25, c.slideSize.height * 0.4, c.slideSize.width * 0.5, 40];

/** deckcraft `paste_plain`. */
function pastePlain(ctx, cmd, text) {
  if (textSelection(ctx.doc, ctx.selection)) return insertText(ctx, cmd, text);
  return addTextBox(ctx, cmd, pasteRect(ctx.doc), text);
}

/** deckcraft `paste_external_body`: formatted text from another app. */
function pasteExternalBody(ctx, cmd, body) {
  if (textSelection(ctx.doc, ctx.selection)) return pasteBody(ctx, cmd, body);
  const made = addTextBox(ctx, cmd, pasteRect(ctx.doc), bodyText(body));
  const id = made?.id;
  const sel = selectionOf(ctx);
  const sh = id && findShape(sel.slide?.shapes, id);
  if (!sh) throw bad(cmd, 'no text box');
  const path = [...slidePath(ctx.doc, sel.slideId), 'shapes', sel.slide.shapes.findIndex(x => x.id === id), 'text'];
  const t = sh.text ?? {body: {}, paragraphs: []};
  const nb = {...structuredClone(body), body: {...(body.body ?? {}), wrap: t.body?.wrap, autofit: t.body?.autofit}};
  for (const k of ['wrap', 'autofit']) if (nb.body[k] === undefined) delete nb.body[k];
  ctx.change.set(path, nb);
  fitTextBox(ctx, sel.slideId, id, ctx.host);
  selectShapeIds(ctx, sel.slideId, [id]);
  return {id};
}

/** What the paste reads: our clipboard (internal) or another app's text and HTML (external). */
async function source(ctx, p) {
  if (typeof p.text === 'string') {
    const ours = clip(ctx);
    if (ours && p.text === (ours.data?.plain ?? ours.text)) return {internal: ours};
    return {text: p.text, html: typeof p.html === 'string' ? p.html : ''};
  }
  let r;
  try { r = await readClipboard(ctx); } catch { r = null; }
  if (r?.source === 'internal' && r.kind?.startsWith('prism.')) return {internal: clip(ctx) ?? r};
  if (r && r.text) return {text: r.text, html: r.html ?? ''};
  // A picture copied in another program (a screenshot): it goes on the slide as a picture.
  if (r?.picture) return {text: '', html: '', picture: r.picture};
  const ours = clip(ctx);
  return ours ? {internal: ours} : {text: '', html: ''};
}

/** deckcraft `paste` with the clipboard `src` (`theme`: Keep Source Formatting bakes the source theme in). */
function pasteFrom(ctx, cmd, src, {keepSource = false} = {}) {
  if (!src.internal) {
    if (src.picture && !src.text) return ctx.run('insert.picture', {name: 'Pasted picture', data: src.picture});
    const t = src.text ?? '';
    if (src.html) {
      const body = htmlToBody(src.html);
      if (body && sameWords(bodyText(body), t)) return pasteExternalBody(ctx, cmd, body);
    }
    if (!t) return {};
    // Tab-separated text over a selected range of cells fills them.
    const filled = pasteTextCells(ctx, cmd, t);
    if (filled) return filled;
    return pastePlain(ctx, cmd, t);
  }
  const cb = src.internal;
  const data = cb.data ?? {};
  const editing = !!textSelection(ctx.doc, ctx.selection);
  // Copied cells go into the table at the caret or the selected cells; a single cell pasted at a caret is its text.
  if (cb.kind === 'prism.cells' && data.rows?.length && (!editing || (data.rows.length > 1 || data.rows[0].length > 1) && pastesIntoTable(ctx))) return pasteCells(ctx, cmd, data);
  if (editing) {
    if (cb.kind === 'prism.text' && data.text) return pasteBody(ctx, cmd, data.text);
    return pastePlain(ctx, cmd, data.plain ?? cb.text ?? '');
  }
  if (cb.kind === 'prism.slides' && (data.slides ?? []).length) {
    const sel = selectionOf(ctx);
    const at = sel.slideIndex + 1;
    const holder = {pres: ctx.doc};
    const media = bringMedia(cmd, holder, data.media);
    const made = [];
    for (const sl0 of data.slides) {
      const id = takeId(holder, cmd);
      const {shapes, map} = reid(cmd, holder, sl0.shapes ?? []);
      let sl = remapMedia({...structuredClone(sl0), id, shapes, animations: remapAnimations(sl0.animations, map)}, media);
      if (!layoutById(holder.pres, sl.layout)) sl = {...sl, layout: holder.pres.masters?.[0]?.layouts?.[0]?.id ?? sl.layout};
      made.push(sl);
    }
    ctx.change.set(['nextId'], holder.pres.nextId);
    if ((holder.pres.media ?? []) !== (ctx.doc.media ?? [])) ctx.change.set(['media'], holder.pres.media);
    made.forEach((sl, k) => ctx.change.splice(['slides'], Math.min(at + k, ctx.doc.slides.length), 0, sl));
    const ids = made.map(x => x.id);
    selectSlideList(ctx, ids, ids[ids.length - 1]);
    return {slides: ids.length};
  }
  if (cb.kind === 'prism.shapes' && (data.shapes ?? []).length) {
    const sel = selectionOf(ctx);
    if (!sel.slide) throw bad(cmd, 'no slide');
    const key = String(cb.time ?? '');
    const prev = ctx.view?.pasteCount;
    const pastes = (prev && prev.key === key ? prev.n : 0) + 1;
    ctx.setView({pasteCount: {key, n: pastes}});
    // Pasting on another slide keeps the position; on the same slide it offsets.
    const sameSlide = data.shapes.some(x => findShape(sel.slide.shapes, x.id));
    const off = sameSlide ? duplicateOffset(ctx) * pastes : 0;
    const holder = {pres: ctx.doc};
    const media = bringMedia(cmd, holder, data.media);
    const baked = keepSource && data.sourceTheme ? bakeTheme(data.shapes, data.sourceTheme) : data.shapes;
    let {shapes} = reid(cmd, holder, baked);
    shapes = remapMedia(shapes, media);
    const taken = currentNames(sel.slide);
    shapes = shapes.map(sh0 => {
      const sh = {...sh0};
      // Only a name already on the slide changes; otherwise it stays (Morph pairs shapes by name).
      const m = /^(.*) (\d+)$/u.exec(sh.name ?? '');
      if (taken.has(sh.name) && m) {
        let n = taken.size + 1;
        while (taken.has(`${m[1]} ${n}`)) n += 1;
        sh.name = `${m[1]} ${n}`;
      }
      taken.add(sh.name);
      if (sh.xfrm) sh.xfrm = {...sh.xfrm, x: sh.xfrm.x + off, y: sh.xfrm.y + off};
      // A pasted placeholder becomes a regular shape keeping its look.
      if (sh.ph) sh.ph = null;
      return sh;
    });
    const sp = slidePath(ctx.doc, sel.slideId);
    ctx.change.set(['nextId'], holder.pres.nextId);
    if ((holder.pres.media ?? []) !== (ctx.doc.media ?? [])) ctx.change.set(['media'], holder.pres.media);
    ctx.change.splice([...sp, 'shapes'], sel.slide.shapes.length, 0, ...shapes);
    const ids = shapes.map(x => x.id);
    selectShapeIds(ctx, sel.slideId, ids);
    return {ids};
  }
  const plain = data.plain ?? cb.text ?? '';
  return plain ? pastePlain(ctx, cmd, plain) : {};
}

/** deckcraft `delete`. */
function deleteSel(ctx, p) {
  const ids0 = idsParam(p, 'ids');
  if (textSelection(ctx.doc, ctx.selection) && ids0 === undefined) return deleteDir(ctx, 'edit.delete', 'forward');
  if (slidesScope(ctx, p) && ids0 === undefined) return ctx.run('slide.delete', {});
  // With table cells selected, Delete clears their text and keeps the table, as in PowerPoint.
  if (ids0 === undefined && p?.id === undefined && cellSelection(ctx.doc, ctx.selection) && ctx.registry?.has?.('table.clearCells')) return ctx.run('table.clearCells', {});
  const ids = targets(ctx, p, 'edit.delete');
  if (!ids.length) return {};
  const sel = selectionOf(ctx);
  const sp = slidePath(ctx.doc, sel.slideId);
  if (!sp) throw bad('edit.delete', 'no slide');
  const before = [];
  walk(sel.slide.shapes, x => before.push(x.id));
  const {shapes, removed} = removeShapes(sel.slide.shapes, ids);
  const left = new Set();
  walk(shapes, x => left.add(x.id));
  // Everything that is gone: the given ids plus group descendants and emptied groups.
  const gone = new Set([...ids, ...before.filter(i => !left.has(i))]);
  const anims = (sel.slide.animations ?? []).filter(a => !gone.has(a.shape)).map(a => (a.trigger != null && gone.has(a.trigger) ? {...a, trigger: null} : a));
  ctx.change.set([...sp, 'shapes'], shapes);
  if ((sel.slide.animations ?? []).length !== anims.length || anims.some((a, i) => a !== sel.slide.animations[i])) ctx.change.set([...sp, 'animations'], anims);
  selectShapeIds(ctx, sel.slideId, sel.shapes.filter(i => !gone.has(i)));
  return {deleted: removed};
}

export default defineCommands({
  family: 'edit',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.cut', label: 'Cut', risk: 'edit', shortcut: 'Mod+X',
      description: 'Cut (Home › Clipboard): copy the selected text, shapes or slides to the clipboard and remove them; a caret alone cuts nothing.',
      params: s.object({scope}), state: hasDoc,
      async run(ctx, p) {
        // A caret alone: nothing is selected, so nothing is cut (Delete would remove the next character).
        const t = textSelection(ctx.doc, ctx.selection);
        if (t && t.anchor === t.caret) return {text: '', html: ''};
        const r = await copy(ctx, p);
        deleteSel(ctx, p);
        return r;
      },
    },
    {
      id: 'edit.copy', label: 'Copy', risk: 'read', effect: 'view', shortcut: 'Mod+C',
      description: 'Copy (Home › Clipboard): the selected text (with its formatting as HTML), shapes or slides go to the clipboard; returns {text, html}.',
      params: s.object({scope}), state: hasDoc,
      run: (ctx, p) => copy(ctx, p),
    },
    {
      id: 'edit.paste', label: 'Paste', risk: 'edit', shortcut: 'Mod+V',
      description: 'Paste (Home › Clipboard): what was copied (text at the insertion point, shapes on the current slide, slides after the current one) or another app\'s text (bold, italic and underline kept from its HTML); outside text a new text box holds pasted text.',
      params: s.object({text: s.optional(s.string({max: 10000000})), html: s.optional(s.string({max: 2000000})), scope}),
      state: hasDoc,
      async run(ctx, p) { return pasteFrom(ctx, 'edit.paste', await source(ctx, p)); },
    },
    {
      id: 'edit.pasteSpecial', label: 'Paste Special', risk: 'edit', dialog: 'dialog.pasteSpecial', shortcut: 'Mod+Alt+V',
      description: 'Paste Special: Use Destination Theme (as Paste), Keep Source Formatting (the copied shapes keep the colours and fonts of their own theme) or Keep Text Only.',
      params: s.object({as: s.enum(AS)}),
      state: hasDoc,
      async run(ctx, p) {
        const as = p.as ?? 'destinationTheme';
        const src = await source(ctx, {});
        if (as === 'text' || as === 'keepTextOnly') {
          const t = src.internal ? (src.internal.data?.plain ?? src.internal.text ?? '') : src.text ?? '';
          return pastePlain(ctx, 'edit.pasteSpecial', t);
        }
        if (as === 'keepSource' || as === 'keepSourceFormatting') return pasteFrom(ctx, 'edit.pasteSpecial', src, {keepSource: true});
        return pasteFrom(ctx, 'edit.pasteSpecial', src);
      },
    },
    {
      id: 'edit.pasteText', label: 'Paste and Match Formatting', risk: 'edit', shortcut: 'Mod+Shift+V',
      description: 'Paste and Match Formatting: paste the clipboard\'s plain text (or `text`), taking the formatting where it lands.',
      params: s.object({text: s.optional(s.string({max: 10000000}))}),
      state: hasDoc,
      async run(ctx, p) {
        let t = p.text;
        if (typeof t !== 'string') {
          const src = await source(ctx, {});
          t = src.internal ? (src.internal.data?.plain ?? src.internal.text ?? '') : src.text ?? '';
        }
        return pastePlain(ctx, 'edit.pasteText', t);
      },
    },
    {
      id: 'edit.duplicate', label: 'Duplicate', risk: 'edit', shortcut: 'Mod+D',
      description: 'Duplicate (Ctrl+D): copy the selected shapes onto the slide, offset; duplicating the copies again repeats how far they were moved.',
      params: s.object({ids: s.optional(s.array(shapeId, {max: 5000}))}),
      state: hasSelection,
      run(ctx, p) {
        const ids = targets(ctx, p, 'edit.duplicate');
        const sel = selectionOf(ctx);
        if (!sel.slide) throw bad('edit.duplicate', 'no slide');
        const list = sel.slide.shapes;
        const copies0 = list.filter(x => ids.includes(x.id));
        const sources = copies0.map(x => x.id);
        const boxes = copies0.map(x => xfrmOf(ctx.doc, sel.slideId, x));
        const off = duplicateOffset(ctx);
        // Duplicating the copies of the last Duplicate again repeats how far they were moved since; anything else gets the usual offset.
        let d = [off, off];
        const last = ctx.view?.lastDuplicate;
        if (last && last.slide === sel.slideId && last.pairs.length === sources.length && last.pairs.every(([, c]) => sources.includes(c))) {
          const [src, cp] = last.pairs[0];
          const a = list.find(x => x.id === src), b = list.find(x => x.id === cp);
          if (a && b) {
            const xa = xfrmOf(ctx.doc, sel.slideId, a), xb = xfrmOf(ctx.doc, sel.slideId, b);
            const dd = [xb.x - xa.x, xb.y - xa.y];
            if (dd.every(Number.isFinite)) d = dd;
          }
        }
        const holder = {pres: ctx.doc};
        let {shapes} = reid('edit.duplicate', holder, copies0);
        shapes = shapes.map((c, i) => {
          const x = {...boxes[i], x: boxes[i].x + d[0], y: boxes[i].y + d[1]};
          const n = {...c, xfrm: x, ph: null};
          if (n.name) n.name = `${n.name.replace(/( copy)+$/u, '')} copy`;
          return n;
        });
        const sp = slidePath(ctx.doc, sel.slideId);
        ctx.change.set(['nextId'], holder.pres.nextId);
        ctx.change.splice([...sp, 'shapes'], list.length, 0, ...shapes);
        const newIds = shapes.map(x => x.id);
        selectShapeIds(ctx, sel.slideId, newIds);
        ctx.setView({lastDuplicate: {slide: sel.slideId, pairs: sources.map((src, i) => [src, newIds[i]])}});
        return {ids: newIds};
      },
    },
    {
      id: 'edit.delete', label: 'Delete', risk: 'edit', shortcut: 'Delete',
      description: 'Delete: the selected shapes (with their animations), or `ids`; while editing text, the next character or the selected text; with slides selected in the slide list, those slides.',
      params: s.object({ids: s.optional(s.array(shapeId, {max: 5000})), id: s.optional(shapeId), scope}),
      state: hasDoc,
      run: (ctx, p) => deleteSel(ctx, p),
    },
    {
      id: 'edit.selectAll', label: 'Select All', risk: 'read', effect: 'view', shortcut: 'Mod+A',
      description: 'Select All: every visible, unlocked shape on the slide; all of the text being edited; or with `scope: slides` every slide (the current slide stays).',
      params: s.object({scope}), state: hasSlide,
      run(ctx, p) {
        const sel = selectionOf(ctx);
        if (p.scope === 'slides') {
          const ids = ctx.doc.slides.map(x => x.id);
          selectSlideList(ctx, ids, sel.slideId);
          return {selected: ids};
        }
        if (sel.text) return ctx.run('text.selectAll', {});
        const ids = (sel.slide?.shapes ?? []).filter(x => !x.hidden && !x.locked).map(x => x.id);
        selectShapeIds(ctx, sel.slideId, ids);
        return {ids};
      },
    },
    {
      id: 'edit.deselect', label: 'Deselect', risk: 'read', effect: 'view', shortcut: 'Escape', shortcutContext: 'prism.shape',
      description: 'Deselect (Escape): leaving text editing selects the shape; otherwise nothing stays selected. Disarms the Format and Animation Painters.',
      params: s.object({}), state: hasDoc,
      run(ctx) {
        if (ctx.view?.painter || ctx.view?.animPainter) ctx.setView({painter: null, animPainter: null});
        const sel = selectionOf(ctx);
        if (sel.text) {
          // Esc while editing text selects the shape.
          if (!sel.text.notes) selectShapeIds(ctx, sel.slideId, [sel.text.shape]);
          else selectSlideList(ctx, [sel.slideId], sel.slideId);
        } else if (sel.slideId) selectSlideList(ctx, [sel.slideId], sel.slideId);
        return {};
      },
    },
    {
      id: 'edit.select', label: 'Select Objects', risk: 'read', effect: 'view',
      description: 'Select shapes on the current slide by id: replace the selection, `add` to it or `toggle` them (Ctrl+click).',
      params: s.object({ids: s.optional(s.array(shapeId, {max: 5000})), id: s.optional(shapeId), add: s.optional(s.boolean()), toggle: s.optional(s.boolean())}),
      state: hasSlide,
      run(ctx, p) {
        const ids = idsParam(p, 'ids') ?? (p.id !== undefined && idOf(p.id) ? [idOf(p.id)] : []);
        const sel = selectionOf(ctx);
        const valid = ids.filter(i => findShape(sel.slide?.shapes, i));
        let next;
        if (p.toggle) {
          next = [...sel.shapes];
          for (const i of valid) { const k = next.indexOf(i); if (k >= 0) next.splice(k, 1); else next.push(i); }
        } else if (p.add) {
          next = [...sel.shapes];
          for (const i of valid) if (!next.includes(i)) next.push(i);
        } else next = valid;
        selectShapeIds(ctx, sel.slideId, next);
        return {selected: next};
      },
    },
  ],
});

