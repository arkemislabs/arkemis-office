// The read-only view of a Quill document layout works on: the body as one block array, sections
// with their defaults filled in, and memoised style resolution.
//
// Upstream layout reads `wordcraft_doc::Document` directly (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c); the JS model keeps the body in chunks
// (core/quill/model/body.mjs) and resolves formatting through `styles.mjs`, so layout reads
// committed content through this view. Blocks keep their identity across versions (structural
// sharing): the paragraph cache (`cache.mjs`) keys on them.
import {resolveChar, resolvePara} from '../model/styles.mjs';
import {sectionOf} from '../model/section.mjs';
import {Document} from '../model/document.mjs';

const EMPTY = Object.freeze({});

export class LDoc {
  /** `src`: schema-2 content, or a model `Document`. */
  constructor(src) {
    const content = src instanceof Document ? src.content : src;
    if (!content?.body?.chunks) throw new Error('Not Quill schema-2 content');
    this.content = content;
    this.styles = content.styles;
    this.numbering = content.numbering;
    this.settings = content.settings;
    this.parts = content.parts ?? {};
    this.body = content.body.chunks.length === 1 ? content.body.chunks[0] : content.body.chunks.flat();
    this._chars = new Map();
    this._paras = new Map();
    this._sections = null;
  }
  /** Section properties per section: [[index of the body block that ends it, section]]. */
  sections() {
    if (this._sections) return this._sections;
    const v = [];
    const bl = this.body;
    for (let i = 0; i < bl.length; i++) { const b = bl[i]; if (b.kind === 'para' && b.section) v.push([i, sectionOf(b.section)]); }
    v.push([Math.max(0, bl.length - 1), sectionOf(this.content.lastSection)]);
    this._sections = v;
    return v;
  }
  /** Footnote or endnote options in effect in a section (note_options). */
  noteOptions(sect, endnote) {
    const own = (endnote ? sect.endnotePr : sect.footnotePr) || {};
    const doc = (endnote ? this.settings.endnotePr : this.settings.footnotePr) || {};
    const fmt = endnote ? this.settings.endnoteFormat : this.settings.footnoteFormat;
    let pos = own.pos ?? doc.pos ?? null;
    if (endnote) pos = pos === 'sectEnd' || pos === 'docEnd' ? pos : 'docEnd';
    else pos = pos === 'pageBottom' || pos === 'beneathText' ? pos : 'pageBottom';
    return {pos, numFmt: own.numFmt ?? fmt, numStart: Math.max(1, Math.min(32_767, own.numStart ?? doc.numStart ?? 1)),
      numRestart: own.numRestart ?? doc.numRestart ?? 'continuous'};
  }
  part(id) { return this.parts[id] ?? null; }
  /** Resolved character formatting, memoised per (paragraph style, table formatting, run props). */
  resolveChar(paraStyle, props, tableChr = null) {
    const k = paraStyle ?? '';
    let byTable = this._chars.get(k);
    if (!byTable) { byTable = new Map(); this._chars.set(k, byTable); }
    const tk = tableChr ?? EMPTY;
    let byProps = byTable.get(tk);
    if (!byProps) { byProps = new WeakMap(); byTable.set(tk, byProps); }
    const pk = props ?? EMPTY;
    let rc = byProps.get(pk);
    if (!rc) { rc = resolveChar(this.styles, paraStyle, pk, tableChr); byProps.set(pk, rc); }
    return rc;
  }
  /** Resolved paragraph formatting (without list indents), memoised per props object. */
  resolvePara(props, tablePara = null) {
    const tk = tablePara ?? EMPTY;
    let byProps = this._paras.get(tk);
    if (!byProps) { byProps = new WeakMap(); this._paras.set(tk, byProps); }
    const pk = props ?? EMPTY;
    let rp = byProps.get(pk);
    if (!rp) { rp = resolvePara(this.styles, pk, tablePara); byProps.set(pk, rp); }
    return rp;
  }
  /** The move name of revision `idx` (Document::move_name). */
  moveName(idx) { return this.content.revisions?.[idx]?.moveName ?? null; }
}
