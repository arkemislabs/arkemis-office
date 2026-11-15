// Styles (Home › Styles): apply, create, modify, update to match, delete, show/hide, the gallery,
// the Styles pane and Manage Styles, over the schema-2 model.
// Translated from wordcraft crates/engine/src/cmd/para.rs (`para.style`, `para.normal`,
// `para.heading1-3`, `styles.*` specs) and crates/engine/src/cmd/para/styles.rs (`style_id`,
// `apply_styles`, `apply_style`, `create_style`, `modify_style`, `update_to_match`, `retarget`,
// `strip_matching`, `delete_style`, `set_visibility`) at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The Styles pane is view state: `styles.pane` / `styles.apply` without a style flip
// `ctx.view.stylesPane`; the shell's Styles launcher opens the pane itself.
//
// Not translated here: deleting a table style (para/styles.rs hands it to cmd/table_style.rs
// `delete`, the table_style family's); `styles.delete` refuses table styles meanwhile.

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import * as P from '../../model/para.mjs';
import {charOverlaid, paraOverlaid, charWithoutSymbol, charFormatting, paraFormatting, same} from '../../model/props.mjs';
import {findStyle, getStyle, upsertStyle, removeStyle, newStyleId, resolvePara, paraStyleProps, chain, resolveChar, style as mkStyle} from '../../model/styles.mjs';
import {samePath, samePos} from '../../model/document.mjs';
import {UPSTREAM_COMMIT, ready, need, ordered, focusOf, selectedPaths, fmtParas, selResult, applyChar, clearPending, peek}
  from '../../lib/format-target.mjs';
import {manageList, galleryItems} from '../../lib/para-lists.mjs';
import {readCharProps} from '../format.mjs';
import {readParaProps} from '../para.mjs';

const UPSTREAM = {repo: 'wordcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/para.rs', 'crates/engine/src/cmd/para/styles.rs',
  'crates/engine/src/cmd/para/lists.rs']};
const NONE = s.object({});

/** A style's tile in the Styles gallery: its sample in its own resolved font, size, weight and colour (the look Word previews), its name under it. */
function styleArt(sheet, it) {
  try {
    const rc = it.kind === 'character' ? resolveChar(sheet, 'Normal', {style: it.id}) : resolveChar(sheet, it.id, {});
    const rgb = rc.color && typeof rc.color === 'object' && Array.isArray(rc.color.Rgb) ? rc.color.Rgb : Array.isArray(rc.color) ? rc.color : null;
    const color = rgb ? `#${rgb.map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('')}` : null;
    return {kind: 'textStyle', label: it.label, font: rc.font, size: rc.size, bold: !!rc.bold, italic: !!rc.italic, color, caps: !!rc.caps, smallCaps: !!rc.smallCaps,
      underline: rc.underline && rc.underline !== 'none', strike: !!rc.strike, spacing: rc.spacing ? Math.max(-1, Math.min(3, rc.spacing / 2)) : 0};
  } catch { return {kind: 'textStyle', label: it.label}; }
}

/** A style id from a name or id (`style_id`). */
export function styleId(sheet, name) {
  const st = findStyle(sheet, name);
  if (!st) throw new CommandError('invalid_params', `no style \`${name}\``, {path: '/style'});
  return st.id;
}

// ---------------------------------------------------------------------------------------------
// Apply

/** Apply a paragraph (or character) style to the selection (`apply_style`). */
export function applyStyle(ctx, name) {
  need(ctx);
  const sheet = ctx.doc.styles;
  const id = styleId(sheet, name);
  const kind = getStyle(sheet, id)?.kind ?? 'paragraph';
  if (kind === 'character') return applyChar(ctx, c => { c.style = id; });
  ctx.model.edit(ctx, d => {
    const [a, b] = ordered(ctx, d);
    // A style linked to a list level (a heading in a numbered-headings list) brings its number.
    const numbered = !!resolvePara(d.styles, {style: id}).numbering;
    fmtParas(d, a.story, selectedPaths(ctx, d), p => {
      p.style = id;
      // Applying a heading or Normal removes direct list numbering (except list styles); a
      // numbered style's own number replaces any direct numbering, even numbering switched off.
      if (numbered || ((id.startsWith('Heading') || id === 'Title' || id === 'Normal') && p.numbering && p.numbering.num !== 0)) delete p.numbering;
    });
    // A paragraph style resets direct character formatting that matches nothing (Word keeps direct
    // formatting unless it covers most of the paragraph; upstream clears font, size and colour).
    if (samePath(a.path, b.path) || samePos(a, b)) {
      const drop = c => { delete c.font; delete c.fontCs; delete c.fontEa; delete c.size; delete c.sizeCs; delete c.color; };
      for (const path of d.pathsBetween(a, b)) {
        const para = d.paraMut(a.story, path);
        P.formatRange(para, 0, para.text.length, drop);
        const mark = P.applyProps(P.markOf(para), drop);
        if (Object.keys(mark).length) para.mark = mark; else delete para.mark;
      }
    }
  });
  clearPending(ctx);
  return selResult(ctx);
}

// ---------------------------------------------------------------------------------------------
// Create, modify, update to match, delete

/** The style kinds Create New Style From Formatting offers (Word's Style type box, without Table and List). */
export const NEW_STYLE_KINDS = Object.freeze(['paragraph', 'character', 'linked']);

function createStyle(ctx, p) {
  need(ctx);
  const name = String(p.name ?? '').trim();
  if (!name) throw new CommandError('invalid_params', 'name is empty', {path: '/name'});
  if (findStyle(ctx.doc.styles, name)) throw new CommandError('failed', `a style named \`${name}\` already exists`);
  const kind = p.kind ?? 'paragraph';
  const chrOver = p.chr === undefined ? null : readCharProps(p.chr, '/chr');
  const paraOver = p.para === undefined ? null : readParaProps(p.para);
  if (p.basedOn && !findStyle(ctx.doc.styles, p.basedOn)) throw new CommandError('invalid_params', `no style \`${p.basedOn}\``, {path: '/basedOn'});
  if (p.next && !findStyle(ctx.doc.styles, p.next)) throw new CommandError('invalid_params', `no style \`${p.next}\``, {path: '/next'});
  let id;
  ctx.model.edit(ctx, d => {
    id = newStyleId(d.styles, name);
    const charKind = kind === 'character';
    const based = (p.basedOn ? findStyle(d.styles, p.basedOn)?.id : null) ?? (charKind ? 'DefaultParagraphFont' : 'Normal');
    const next = charKind ? null : (p.next ? findStyle(d.styles, p.next)?.id : null) ?? id;
    const st = mkStyle({id, name, kind: charKind ? 'character' : 'paragraph', basedOn: based, next, quick: p.gallery ?? true, priority: 50});
    const f = focusOf(ctx, d);
    const para = d.paraAt(f);
    if ((p.fromSelection ?? true) && para) {
      if (!charKind) {
        const pp = paraFormatting({...(para.props ?? {})});
        delete pp.style; delete pp.numbering;
        st.para = pp;
      }
      // A symbol's own font is the symbol's, not the style's.
      const chr = charWithoutSymbol(P.propsAt(para, f.off));
      for (const k of ['style', 'link', 'ins', 'del', 'fmtChange']) delete chr[k];
      st.chr = chr;
    }
    if (chrOver) st.chr = charOverlaid(st.chr ?? {}, chrOver);
    if (paraOver && !charKind) st.para = paraOverlaid(st.para ?? {}, paraOver);
    let sheet = upsertStyle(d.styles, st);
    if (kind === 'linked') {
      // Word's linked style: the paragraph style and its "<name> Char" character twin, each naming the other.
      const charId = newStyleId(sheet, `${name} Char`);
      sheet = upsertStyle(sheet, {...st, linked: charId});
      sheet = upsertStyle(sheet, mkStyle({id: charId, name: `${name} Char`, kind: 'character', basedOn: 'DefaultParagraphFont', linked: id,
        chr: {...(st.chr ?? {})}, hidden: false, quick: false, priority: 50}));
    }
    d.setField('styles', sheet);
  });
  applyStyle(ctx, id);
  return {...selResult(ctx), id};
}

function modifyStyle(ctx, p) {
  need(ctx);
  const id = styleId(ctx.doc.styles, p.style);
  const chr = p.chr === undefined ? null : readCharProps(p.chr, '/chr');
  const para = p.para === undefined ? null : readParaProps(p.para);
  const based = p.basedOn === undefined ? undefined : p.basedOn === null || p.basedOn === '' ? null : styleId(ctx.doc.styles, p.basedOn);
  if (based && based === id) throw new CommandError('invalid_params', 'a style cannot be based on itself', {path: '/basedOn'});
  if (based && chain(ctx.doc.styles, based).some(x => (x?.id ?? x) === id)) throw new CommandError('invalid_params', 'that would base the style on itself', {path: '/basedOn'});
  if (typeof p.name === 'string' && p.name.trim()) {
    const other = findStyle(ctx.doc.styles, p.name.trim());
    if (other && other.id !== id) throw new CommandError('failed', `a style named \`${p.name.trim()}\` already exists`);
  }
  ctx.model.edit(ctx, d => {
    const st = {...getStyle(d.styles, id)};
    if (chr) st.chr = charOverlaid(st.chr ?? {}, chr);
    if (para) st.para = paraOverlaid(st.para ?? {}, para);
    if (typeof p.next === 'string') st.next = p.next ? styleId(d.styles, p.next) : null;
    if (typeof p.name === 'string' && p.name.trim()) st.name = p.name.trim();
    if (based !== undefined) st.basedOn = based;
    if (typeof p.gallery === 'boolean') st.quick = p.gallery;
    d.setField('styles', upsertStyle(d.styles, st));
  });
  return selResult(ctx);
}

/** Character properties Update to Match leaves alone: the character style, links and revisions. */
const CHAR_KEEP = ['style', 'link', 'ins', 'del', 'fmtChange'];
/** Paragraph properties Update to Match leaves alone: the style, its outline level, list numbering and revisions. */
const PARA_KEEP = ['style', 'outlineLevel', 'numbering', 'numChange', 'fmtChange'];

/** A style's own properties changed so that its chain gives `want` where it gave `have` (`retarget`). */
function retarget(own, have, want, keep) {
  const out = {...(own ?? {})};
  for (const k of new Set([...Object.keys(have), ...Object.keys(want)])) {
    if (keep.includes(k) || same(have[k], want[k])) continue;
    if (want[k] !== undefined) out[k] = want[k]; else delete out[k];
  }
  return out;
}

/** `direct` without the properties that have the same value in `inherited` (`strip_matching`). */
function stripMatching(direct, inherited, keep) {
  const out = {};
  for (const [k, v] of Object.entries(direct ?? {})) if (keep.includes(k) || !same(inherited[k], v)) out[k] = v;
  return out;
}

/** The character formatting a character style chain adds over `c` (paragraph or character styles). */
function charChain(sheet, c, styleIdOrNull) {
  let out = c;
  if (!styleIdOrNull) return out;
  for (const st of chain(sheet, styleIdOrNull)) if (st.kind === 'character' || st.kind === 'paragraph') out = charOverlaid(out, st.chr ?? {});
  return out;
}

/**
 * Update Style to Match Selection: the style takes on how the selection looks (paragraph style,
 * character style and direct formatting at its start), then the selected paragraphs take the style
 * and drop the direct formatting it now carries. The style keeps its outline level and numbering.
 */
function updateToMatch(ctx, p) {
  need(ctx);
  ctx.model.edit(ctx, d => {
    const [a, b] = ordered(ctx, d);
    const para = d.paraAt(a);
    if (!para) return;
    const sheet = d.styles;
    const id = p.style !== undefined ? styleId(sheet, p.style) : para.props?.style ?? 'Normal';
    const tgt = getStyle(sheet, id);
    if (!tgt) throw new CommandError('invalid_params', `no style \`${id}\``, {path: '/style'});
    if (tgt.kind !== 'paragraph' && tgt.kind !== 'character') throw new CommandError('failed', `\`${tgt.name}\` can't be updated to match the selection`);
    const direct = charWithoutSymbol(samePos(a, b) ? P.propsAt(para, a.off) : P.propsOfChar(para, a.off));
    const paraStyle = para.props?.style ?? 'Normal';
    let [wantP, wantC] = paraStyleProps(sheet, paraStyle);
    wantC = charChain(sheet, wantC, direct.style ?? null);
    const directFmt = charFormatting(direct);
    delete directFmt.style;
    wantC = charOverlaid(wantC, directFmt);
    const ownP = paraFormatting(para.props ?? {});
    delete ownP.style; delete ownP.numbering;
    wantP = paraOverlaid(wantP, ownP);
    let haveP, haveC;
    if (tgt.kind === 'character') { [haveP, haveC] = paraStyleProps(sheet, paraStyle); haveC = charChain(sheet, haveC, id); }
    else [haveP, haveC] = paraStyleProps(sheet, id);
    const chr = retarget(tgt.chr, haveC, wantC, CHAR_KEEP);
    const pp = tgt.kind === 'paragraph' ? retarget(tgt.para, haveP, wantP, PARA_KEEP) : tgt.para;
    d.setField('styles', upsertStyle(sheet, {...tgt, chr, para: pp}));
    if (tgt.kind === 'paragraph') {
      // The selected paragraphs take the style; what it now gives them needn't stay direct.
      for (const path of d.pathsBetween(a, b)) {
        const m = d.paraMut(a.story, path);
        const props = stripMatching({...(m.props ?? {}), style: id}, wantP, PARA_KEEP);
        m.props = props;
        P.formatRange(m, 0, m.text.length, c => stripMatching(c, wantC, CHAR_KEEP));
        const mark = stripMatching(P.markOf(m), wantC, CHAR_KEEP);
        if (Object.keys(mark).length) m.mark = mark; else delete m.mark;
      }
    }
  });
  clearPending(ctx);
  return selResult(ctx);
}

function deleteStyle(ctx, p) {
  need(ctx);
  const sheet = ctx.doc.styles;
  const id = styleId(sheet, p.style);
  const st = getStyle(sheet, id);
  if (st.kind === 'table') throw new CommandError('failed', `\`${st.name}\` is a table style: delete it from Table Design › Table Styles`);
  if (st.builtin) throw new CommandError('failed', `\`${st.name}\` is a built-in style and can't be deleted`);
  const gone = [st];
  const partner = st.linked ? getStyle(sheet, st.linked) : null;
  if (partner && !partner.builtin && partner.linked === id) gone.push(partner);
  let restyled = 0;
  ctx.model.edit(ctx, d => {
    for (const g of gone) {
      d.setField('styles', removeStyle(d.styles, g.id).sheet);
      // Fall back to the base only while it is a style of the same kind that still exists.
      const base = g.basedOn && getStyle(d.styles, g.basedOn)?.kind === g.kind ? g.basedOn : null;
      restyled += d.restyle(g.id, base);
    }
  });
  return {deleted: gone.map(g => g.id), restyled};
}

function setVisibility(ctx, p) {
  need(ctx);
  if (p.gallery === undefined && p.hidden === undefined) throw new CommandError('invalid_params', 'give `gallery` and/or `hidden`');
  const id = styleId(ctx.doc.styles, p.style);
  let out;
  ctx.model.edit(ctx, d => {
    const st = {...getStyle(d.styles, id)};
    if (p.hidden !== undefined) st.hidden = p.hidden;
    if (p.gallery !== undefined) {
      st.quick = p.gallery;
      // Showing a style in the gallery unhides it.
      if (p.gallery) st.hidden = false;
    }
    d.setField('styles', upsertStyle(d.styles, st));
    out = {style: st.id, inGallery: !!st.quick && !st.hidden && st.kind !== 'table', hidden: !!st.hidden};
  });
  return out;
}

// ---------------------------------------------------------------------------------------------

const styleParam = s.string({min: 1, max: 253, description: 'name or id'});

/** The style at the caret (the gallery's selected tile, the pane's current style). */
function currentStyle(ctx) {
  const d = peek(ctx);
  return d.paraAt(focusOf(ctx, d))?.props?.style ?? 'Normal';
}

const shortcutStyle = (id, label, styleIdValue, shortcut) => ({
  id, label, shortcut, risk: 'edit',
  description: `${label} (Home › Styles): apply the ${label.replace(/ Style$/, '')} style.`,
  params: NONE,
  state: ctx => { const st = ready(ctx); if (!st.enabled) return st; try { return {enabled: true, checked: currentStyle(ctx) === styleIdValue}; } catch { return st; } },
  run: ctx => applyStyle(ctx, styleIdValue),
});

export default defineCommands({
  family: 'para/styles',
  app: 'quill',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'para.style', label: 'Apply Style', risk: 'edit',
      description: 'Apply Style (Home › Styles): a paragraph style to the selected paragraphs, or a character style to the selection.',
      params: s.object({style: styleParam}),
      state(ctx, p) {
        const st = ready(ctx);
        if (!st.enabled) return st;
        try {
          const cur = currentStyle(ctx);
          // The gallery reads its tiles from the value; a control with a style shows whether it is current.
          if (p?.style) return {enabled: true, checked: findStyle(ctx.doc.styles, p.style)?.id === cur};
          return {enabled: true, value: galleryItems(ctx.doc.styles).map(it => ({...it, art: styleArt(ctx.doc.styles, it)})), current: cur};
        } catch { return st; }
      },
      run: (ctx, p) => applyStyle(ctx, p.style),
    },
    shortcutStyle('para.normal', 'Normal Style', 'Normal', 'Mod+Shift+N'),
    shortcutStyle('para.heading1', 'Heading 1', 'Heading1', 'Mod+Alt+1'),
    shortcutStyle('para.heading2', 'Heading 2', 'Heading2', 'Mod+Alt+2'),
    shortcutStyle('para.heading3', 'Heading 3', 'Heading3', 'Mod+Alt+3'),
    {
      id: 'styles.create', label: 'Create a Style', risk: 'edit', dialog: 'dialog.newStyle',
      description: 'Create a Style (Home › Styles): a new paragraph style from the current paragraph\'s formatting (fromSelection, default true), applied to it.',
      params: s.object({name: s.string({min: 1, max: 253}), basedOn: s.optional(s.string({max: 253})), fromSelection: s.optional(s.boolean()),
        kind: s.optional(s.enum(NEW_STYLE_KINDS)), next: s.optional(s.string({max: 253})), gallery: s.optional(s.boolean()),
        chr: s.optional(s.record(s.any())), para: s.optional(s.record(s.any()))}),
      state: ready,
      run: createStyle,
    },
    {
      id: 'styles.modify', label: 'Modify Style', risk: 'edit', dialog: 'dialog.modifyStyle',
      description: 'Modify Style (Home › Styles): character (`chr`) and paragraph (`para`) formatting over the style\'s own, its name and the style for the following paragraph.',
      params: s.object({style: styleParam, chr: s.optional(s.record(s.any())), para: s.optional(s.record(s.any())), name: s.optional(s.string({max: 253})),
        next: s.optional(s.string({max: 253})), basedOn: s.optional(s.nullable(s.string({max: 253}))), gallery: s.optional(s.boolean())}),
      state: ready,
      run: modifyStyle,
    },
    {
      id: 'styles.updateToMatch', label: 'Update Style to Match Selection', risk: 'edit',
      description: 'Update Style to Match Selection (Home › Styles): the style (default: the paragraph\'s) takes on how the selection looks.',
      params: s.object({style: s.optional(styleParam)}),
      state: ready,
      run: updateToMatch,
    },
    {
      id: 'styles.delete', label: 'Delete Style', risk: 'edit',
      description: 'Delete Style (custom styles only): text using it falls back to its base style; styles based on it are rebased.',
      params: s.object({style: styleParam}),
      state: ready,
      run: deleteStyle,
    },
    {
      id: 'styles.manage', label: 'Manage Styles', risk: 'read', dialog: 'dialog.manageStyles',
      description: 'Manage Styles: every paragraph, character, linked and table style with its type, gallery and hidden flags, base and own formatting.',
      params: s.object({sort: s.optional(s.enum(['recommended', 'alphabetical']))}),
      state: ready,
      run(ctx, p) { need(ctx); return manageList(ctx.doc.styles, p.sort === 'alphabetical'); },
    },
    {
      id: 'styles.setVisibility', label: 'Show or Hide Style', risk: 'edit',
      description: 'Show or Hide Style: in the Styles gallery (w:qFormat) and/or hidden from style lists (w:semiHidden).',
      params: s.object({style: styleParam, gallery: s.optional(s.boolean()), hidden: s.optional(s.boolean())}),
      state: ready,
      run: setVisibility,
    },
    {
      id: 'styles.list', label: 'Styles', risk: 'read',
      description: 'Styles: every style in the document (id, name, kind, in the gallery, based on).',
      params: NONE, state: ready,
      run(ctx) { need(ctx); return ctx.doc.styles.styles.map(st => ({id: st.id, name: st.name, kind: st.kind, quick: !!st.quick, basedOn: st.basedOn ?? null})); },
    },
    {
      id: 'styles.pane', label: 'Styles Pane', shortcut: 'Mod+Alt+Shift+S', risk: 'read', effect: 'view',
      description: 'Styles Pane (Home › Styles): shows or hides the Styles pane.',
      params: NONE,
      state: ctx => { const st = ready(ctx); return st.enabled ? {enabled: true, checked: !!ctx.view?.stylesPane} : st; },
      run(ctx) { need(ctx); const on = !ctx.view?.stylesPane; ctx.setView({stylesPane: on}); return {...selResult(ctx), pane: on}; },
    },
    {
      id: 'styles.apply', label: 'Apply Styles', shortcut: 'Mod+Shift+S', risk: 'edit',
      description: 'Apply Styles: with a style, applies it (one undo step); without one, shows the Styles pane.',
      params: s.object({style: s.optional(s.string({max: 253}))}),
      state: ready,
      run(ctx, p) {
        need(ctx);
        if (p.style === undefined) { ctx.setView({stylesPane: true}); return {pane: true}; }
        if (!p.style.trim()) throw new CommandError('invalid_params', '`style` must not be empty', {path: '/style'});
        return ctx.run('para.style', {style: p.style});
      },
    },
    {
      id: 'styles.addToGallery', label: 'Add to Style Gallery', risk: 'edit',
      description: 'Add to (value:false: Remove from) the Styles gallery.',
      params: s.object({style: styleParam, value: s.optional(s.boolean())}),
      state: ready,
      run(ctx, p) {
        need(ctx);
        const id = styleId(ctx.doc.styles, p.style);
        ctx.model.edit(ctx, d => { const st = getStyle(d.styles, id); d.setField('styles', upsertStyle(d.styles, {...st, quick: p.value ?? true})); });
        return selResult(ctx);
      },
    },
  ],
});

