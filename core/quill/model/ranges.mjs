// Range fields (FieldStart … FieldEnd) and content controls (ControlStart … ControlEnd, and the
// controls kept on tables, rows and cells): pairing, scanning, balancing, and where typing goes.
// Translated from wordcraft crates/doc/src/fields.rs and crates/doc/src/control.rs at
// aadb077e072b7de05f724e359d8db82e151f125c. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Markers pair like brackets and never cross a block list: a pair opened in a table cell closes in
// that cell. Editing can leave a marker without its partner; writers call balanceFieldRanges() /
// balanceControls() so a saved file always has whole fields and controls. No DOM, no Node built-ins.

import * as P from './para.mjs';

/** Deepest table nesting scanned. */
const MAX_DEPTH = 16;
/** Longest tag, title or list text kept from a file. */
export const MAX_CONTROL_TEXT = 1024;
/** Most list entries a combo box or drop-down list keeps. */
export const MAX_LIST_ITEMS = 1000;

// --- control kinds and locks ------------------------------------------------------------------

export const CONTROL_LOCKS = Object.freeze(['unlocked', 'sdtLocked', 'contentLocked', 'sdtContentLocked']);
export const controlLockFromOoxml = v => (['sdtLocked', 'contentLocked', 'sdtContentLocked'].includes(v) ? v : 'unlocked');
export const controlLockOoxml = l => (l && l !== 'unlocked' ? l : null);
export const controlLockFromFlags = (noDelete, noEdit) => (noDelete ? (noEdit ? 'sdtContentLocked' : 'sdtLocked') : noEdit ? 'contentLocked' : 'unlocked');
/** The control itself can be deleted. */
export const lockCanDelete = l => (l ?? 'unlocked') === 'unlocked' || l === 'contentLocked';
/** Its content can be edited. */
export const lockCanEdit = l => (l ?? 'unlocked') === 'unlocked' || l === 'sdtLocked';

/** Default check box symbols: ballot box with X, ballot box. */
export const CHECKED = '☒';
export const UNCHECKED = '☐';
export const checkBoxKind = () => ({type: 'checkBox', checked: false, checkedChar: CHECKED, checkedFont: '', uncheckedChar: UNCHECKED, uncheckedFont: ''});
const KIND_NAMES = {richText: 'richText', text: 'plainText', checkBox: 'checkBox', comboBox: 'comboBox', dropDown: 'dropDown', date: 'date',
  picture: 'picture', gallery: 'buildingBlock', repeatingSection: 'repeatingSection', repeatingSectionItem: 'repeatingSectionItem'};
/** The command-friendly name of a control kind. */
export const controlKindName = k => KIND_NAMES[k?.type ?? 'richText'] ?? 'richText';
/** The words a control's tag shows in Design Mode: its title, else its tag, else its kind. */
export function controlLabel(c) {
  const names = {richText: 'Rich Text', text: 'Plain Text', picture: 'Picture', gallery: 'Building Block', checkBox: 'Check Box', comboBox: 'Combo Box', dropDown: 'Drop-Down List',
    date: 'Date Picker', repeatingSection: 'Repeating Section', repeatingSectionItem: 'Repeating Section Item'};
  return c?.title || c?.tag || names[c?.kind?.type ?? 'richText'] || 'Content Control';
}
/** The list entries of a combo box or drop-down list. */
export const controlItems = k => (k?.type === 'comboBox' || k?.type === 'dropDown' ? k.items ?? [] : null);
/** Typed text may go in (not a check box, drop-down list or picture). */
export const controlTakesTyping = k => !['checkBox', 'dropDown', 'picture'].includes(k?.type);
/** The text its placeholder shows by default. */
export function defaultPlaceholder(k) {
  switch (k?.type ?? 'richText') {
    case 'comboBox': case 'dropDown': return 'Pick an option.';
    case 'date': return 'Pick a date.';
    case 'checkBox': case 'picture': case 'repeatingSection': case 'repeatingSectionItem': return '';
    default: return 'Type here.';
  }
}
/** A list item's stored value: its value, or the display text when empty. */
export const listItemValue = it => (it.value ? it.value : it.display);
/** A new content control of `kind` (ContentControl::new). */
export const contentControl = (kind = {type: 'richText'}) => ({tag: '', title: '', lock: 'unlocked', placeholder: '', showingPlaceholder: false,
  temporary: false, kind, placeholderText: defaultPlaceholder(kind), block: false});
/** The text to show while empty. */
export const placeholderShown = c => (c.placeholderText ? c.placeholderText : defaultPlaceholder(c.kind));
export const controlWrapIsEmpty = w => !w || (!(w.open?.length) && !(w.close));

// --- control events ---------------------------------------------------------------------------

/** The control boundaries of a block list (not looking into cells), in order. */
export function controlEvents(list) {
  const out = [];
  for (const [i, b] of list.entries()) {
    if (b.kind === 'para') {
      if (!P.objectsOf(b).some(o => o.type === 'controlStart' || o.type === 'controlEnd')) continue;
      for (const [off, o] of P.objectsWithOffsets(b)) {
        if (o.type === 'controlStart') out.push({open: true, block: i, off, control: o.control});
        else if (o.type === 'controlEnd') out.push({open: false, block: i, off});
      }
    } else {
      for (const c of b.controls?.open ?? []) out.push({open: true, block: i, off: null, control: c});
      for (let k = 0; k < Math.min(b.controls?.close ?? 0, 10_000); k++) out.push({open: false, block: i, off: null});
    }
  }
  return out;
}

/** Pair events like brackets: [pairs [openIdx, closeIdx, depth] in closing order, orphan indexes]. */
export function pairEvents(events) {
  const open = [], pairs = [], orphans = [];
  events.forEach((e, i) => {
    if (e.open) open.push(i);
    else if (open.length) { const o = open.pop(); pairs.push([o, i, open.length]); } else orphans.push(i);
  });
  orphans.push(...open);
  orphans.sort((a, b) => a - b);
  return [pairs, orphans];
}

/** The start of a control's content (just after the start marker). */
export const controlContentStart = r => ({...r.start, off: r.start.off + 1});
/** Whether `p` is inside the control (between its markers, either edge included). */
export function controlContains(r, p, cmpPath) {
  if (p.story !== r.start.story) return false;
  const ge = (cmpPath(p.path, r.start.path) || p.off - (r.start.off + 1)) >= 0;
  const le = (cmpPath(p.path, r.end.path) || p.off - r.end.off) <= 0;
  return ge && le;
}
/** Whether the content is empty. */
export const controlIsEmpty = (r, samePath) => samePath(r.start.path, r.end.path) && r.end.off === r.start.off + 1;

/** Every control in a list of blocks (and its tables), for walks that need them all. */
export function walkControls(blocks, f) {
  const go = (bl, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const b of bl) {
      if (b.kind === 'para') { for (const o of P.objectsOf(b)) if (o.type === 'controlStart') f(o.control); continue; }
      (b.controls?.open ?? []).forEach(f);
      for (const r of b.rows) {
        (r.controls?.open ?? []).forEach(f);
        for (const c of r.cells) { (c.controls?.open ?? []).forEach(f); go(c.blocks, depth + 1); }
      }
    }
  };
  go(blocks, 0);
}

/** Install the field and control methods on Document (fields.rs and control.rs `impl Document`). */
export function installRanges(D, {ArrayList, BODY, cmpPath, samePath, cmpPos}) {
  const partIds = parts => Object.keys(parts).map(Number).sort((a, b) => a - b);

  function scanFields(story, list, prefix, depth, out) {
    if (depth > MAX_DEPTH) return;
    const open = [];
    for (const [i, b] of list.entries()) {
      prefix.push(i);
      if (b.kind === 'para') {
        const path = prefix.slice();
        for (const [off, o] of P.objectsWithOffsets(b)) {
          if (o.type === 'fieldStart') open.push({instr: o.instr, locked: !!o.locked, start: {story, path, off}});
          else if (o.type === 'fieldEnd') {
            const s = open.pop();
            if (s) out.ranges.push({instr: s.instr, locked: s.locked, start: s.start, end: {story, path, off}, depth: open.length});
            else out.orphans.push([path, off]);
          }
        }
      } else {
        b.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
          prefix.push(r, c);
          scanFields(story, new ArrayList(cell.blocks), prefix, depth + 1, out);
          prefix.pop(); prefix.pop();
        }));
      }
      prefix.pop();
    }
    for (const s of open) out.orphans.push([s.start.path, s.start.off]);
  }
  const scanStory = (story, list) => {
    const out = {ranges: [], orphans: []};
    scanFields(story, list, [], 0, out);
    out.ranges.sort((a, b) => cmpPath(a.start.path, b.start.path) || a.start.off - b.start.off);
    return out;
  };

  function scanControls(story, list, prefix, depth, out) {
    if (depth > MAX_DEPTH) return;
    const events = controlEvents(list);
    if (events.length) {
      const [pairs] = pairEvents(events);
      for (const [o, c, d] of pairs) {
        const eo = events[o], ec = events[c];
        if (eo.off === null || ec.off === null) continue;
        out.push({control: eo.control, start: {story, path: [...prefix, eo.block], off: eo.off}, end: {story, path: [...prefix, ec.block], off: ec.off}, depth: d});
      }
    }
    for (const [i, b] of list.entries()) {
      if (b.kind !== 'table') continue;
      prefix.push(i);
      b.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
        prefix.push(r, c);
        scanControls(story, new ArrayList(cell.blocks), prefix, depth + 1, out);
        prefix.pop(); prefix.pop();
      }));
      prefix.pop();
    }
  }

  function controlOrphans(list, prefix, depth, out, tables) {
    if (depth > MAX_DEPTH) return;
    const events = controlEvents(list);
    const [, lone] = pairEvents(events);
    for (const k of lone) {
      const e = events[k];
      const path = [...prefix, e.block];
      if (e.off !== null) out.push([path, e.off]);
      else if (e.open) {
        const nth = events.slice(0, k).filter(x => x.open && x.off === null && x.block === e.block).length;
        tables.push([path, nth, true]);
      } else tables.push([path, 0, false]);
    }
    for (const [i, b] of list.entries()) {
      if (b.kind !== 'table') continue;
      prefix.push(i);
      b.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
        prefix.push(r, c);
        controlOrphans(new ArrayList(cell.blocks), prefix, depth + 1, out, tables);
        prefix.pop(); prefix.pop();
      }));
      prefix.pop();
    }
  }

  Object.assign(D.prototype, {
    // --- fields.rs ---
    /** The whole range fields of a story, in document order of their starts. */
    fieldRanges(story) { const bl = this.story(story); return bl ? scanStory(story, bl).ranges : []; },
    /** `p` moved past the range-field ends right after it. */
    pastFieldEnds(p) {
      const para = this.paraAt(p);
      if (!para) return {...p};
      let off = p.off;
      for (const [at, o] of P.objectsWithOffsets(para)) {
        if (at < p.off) continue;
        if (at !== off || o.type !== 'fieldEnd') break;
        off += 1;
      }
      return {...p, off};
    },
    /** Whether any story holds a range-field marker without its partner. */
    hasUnbalancedFieldRanges() {
      return [BODY, ...partIds(this.c.parts)].some(s => { const bl = this.story(s); return bl && scanStory(s, bl).orphans.length > 0; });
    },
    /** Remove range-field markers that have no partner; returns how many. */
    balanceFieldRanges() {
      let removed = 0;
      for (const s of [BODY, ...partIds(this.c.parts)]) {
        const bl = this.story(s);
        if (!bl) continue;
        const orphans = scanStory(s, bl).orphans.sort((a, b) => cmpPath(a[0], b[0]) || a[1] - b[1]);
        for (let i = orphans.length - 1; i >= 0; i--) {
          const [path, off] = orphans[i];
          try { this._pDelete(s, path, off, off + 1); removed++; } catch { /* a marker that moved is skipped, as upstream skips errors */ }
        }
      }
      return removed;
    },

    // --- control.rs ---
    /** The whole content controls of a story (around paragraph content), in the order they close. */
    controlRanges(story) { const out = []; const bl = this.story(story); if (bl) scanControls(story, bl, [], 0, out); return out; },
    /** How many content controls allow form filling across every story. */
    fillableControls() {
      return [BODY, ...partIds(this.c.parts)].reduce((n, s) => n + this.controlRanges(s).filter(r => lockCanEdit(r.control.lock)).length, 0);
    },
    /** The innermost content control holding `p`. */
    controlAt(p) {
      const para = this.paraAt(p);
      if (!para) return null;
      if (!P.objectsOf(para).some(o => o.type === 'controlStart' || o.type === 'controlEnd') && !this._storyHasControls(p.story)) return null;
      let best = null;
      for (const r of this.controlRanges(p.story)) {
        if (!controlContains(r, p, cmpPath)) continue;
        if (!best || (cmpPath(r.start.path, best.start.path) || r.start.off - best.start.off) > 0) best = r;
      }
      return best;
    },
    _storyHasControls(s) {
      const bl = this.story(s);
      if (!bl) return false;
      for (const [, b] of bl.entries()) {
        let any = false;
        if (b.kind === 'para') any = P.objectsOf(b).some(o => o.type === 'controlStart');
        else walkControls([b], () => { any = true; });
        if (any) return true;
      }
      return false;
    },
    /** Change the control whose start marker is at `start`: `f(copy)` may mutate or return. */
    updateControl(start, f) {
      const para = this.paraAt(start);
      const o = para && P.objectAt(para, start.off);
      if (!o || o.type !== 'controlStart') return null;
      const p = this.paraMut(start.story, start.path);
      const copy = structuredClone(o.control);
      const r = f(copy);
      const control = r === undefined ? copy : r;
      P.setObjectAt(p, start.off, {...o, control});
      return control;
    },
    /** The content of a control as plain text (paragraphs joined by \n). */
    controlText(r) {
      const a = controlContentStart(r);
      let out = '';
      let first = true;
      for (const path of this.pathsBetween(a, r.end)) {
        const p = this.para(a.story, path);
        if (!p) continue;
        const from = samePath(path, a.path) ? a.off : 0;
        const to = samePath(path, r.end.path) ? r.end.off : p.text.length;
        if (!first) out += '\n';
        first = false;
        let k = P.objectsBefore(p, from);
        for (const c of p.text.slice(from, Math.max(from, to))) {
          if (c === P.OBJ) { out += P.objectPlainText(p.objects?.[k]); k++; } else out += c;
        }
      }
      return out;
    },
    /** Whether any story holds a control marker without its partner. */
    hasUnbalancedControls() {
      return [BODY, ...partIds(this.c.parts)].some(s => {
        const bl = this.story(s);
        if (!bl) return false;
        const ps = [], ts = [];
        controlOrphans(bl, [], 0, ps, ts);
        return ps.length > 0 || ts.length > 0;
      });
    },
    /** Remove control markers (and table wraps' opens and closes) that have no partner. */
    balanceControls() {
      let removed = 0;
      for (const s of [BODY, ...partIds(this.c.parts)]) {
        const bl = this.story(s);
        if (!bl) continue;
        const ps = [], ts = [];
        controlOrphans(bl, [], 0, ps, ts);
        removed += this._removeOrphans(s, ps, ts);
      }
      return removed;
    },
    _removeOrphans(s, paras, tables) {
      let removed = 0;
      paras.sort((a, b) => cmpPath(a[0], b[0]) || a[1] - b[1]);
      for (let i = paras.length - 1; i >= 0; i--) {
        const [path, off] = paras[i];
        try { this._pDelete(s, path, off, off + 1); removed++; } catch { /* skipped as upstream skips errors */ }
      }
      tables.sort((a, b) => cmpPath(a[0], b[0]) || b[1] - a[1]);
      for (const [path, nth, open] of tables) {
        if (!this.table(s, path)) continue;
        this.updateTable(s, path, t => {
          const controls = {open: [...(t.controls?.open ?? [])], close: t.controls?.close ?? 0};
          if (open) { if (nth < controls.open.length) { controls.open.splice(nth, 1); removed++; } }
          else if (controls.close > 0) { controls.close -= 1; removed++; }
          const out = {...t, controls};
          if (controlWrapIsEmpty(controls)) delete out.controls;
          return out;
        });
      }
      return removed;
    },
    /** The control markers in a..b whose partner is outside it (a deletion keeps them), sorted. */
    _keptControlMarkers(a, b) {
      const out = [];
      const paths = this.pathsBetween(a, b);
      const any = paths.some(p => P.objectsOf(this.para(a.story, p) ?? {}).some(o => o.type === 'controlStart' || o.type === 'controlEnd'));
      if (!any) return out;
      const inside = (p, off) => (cmpPath(p, a.path) || off - a.off) >= 0 && (cmpPath(p, b.path) || (off + 1) - b.off) <= 0;
      const ranges = this.controlRanges(a.story);
      for (const r of ranges) {
        const s = inside(r.start.path, r.start.off), e = inside(r.end.path, r.end.off);
        if (s && !e) out.push([r.start.path, r.start.off]);
        if (e && !s) out.push([r.end.path, r.end.off]);
      }
      const key = (p, off) => `${p.join('/')}#${off}`;
      const inRanges = new Set(ranges.flatMap(r => [key(r.start.path, r.start.off), key(r.end.path, r.end.off)]));
      const tablePaired = new Map();
      for (const path of paths) {
        const p = this.para(a.story, path);
        if (!p) continue;
        for (const [off, o] of P.objectsWithOffsets(p)) {
          if (!inside(path, off) || (o.type !== 'controlStart' && o.type !== 'controlEnd') || inRanges.has(key(path, off))) continue;
          const pk = path.slice(0, -1).join('/');
          if (!tablePaired.has(pk)) tablePaired.set(pk, this._tablePairedMarkers(a.story, path));
          if (tablePaired.get(pk).has(`${path[path.length - 1]}#${off}`)) out.push([path, off]);
        }
      }
      out.sort((x, y) => cmpPath(x[0], y[0]) || x[1] - y[1]);
      return out.filter((x, i) => i === 0 || !(samePath(x[0], out[i - 1][0]) && x[1] === out[i - 1][1]));
    },
    /** (block#offset) of the paragraph markers in `path`'s container paired with a table wrap. */
    _tablePairedMarkers(s, path) {
      const out = new Set();
      const bl = this.container(s, path);
      if (!bl) return out;
      const events = controlEvents(bl);
      const [pairs] = pairEvents(events);
      for (const [o, c] of pairs) {
        const open = events[o], close = events[c];
        if (open.off !== null && close.off === null) out.add(`${open.block}#${open.off}`);
        else if (open.off === null && close.off !== null) out.add(`${close.block}#${close.off}`);
      }
      return out;
    },
    /** Where typing at `p` should go: inside a block-level control at a paragraph's start or end. */
    typingPos(p) {
      const para = this.paraAt(p);
      if (!para) return {...p};
      const objs = new Map(P.objectsWithOffsets(para));
      const isStart = off => { const o = objs.get(off); return o?.type === 'controlStart' && !!o.control?.block; };
      const isEnd = off => objs.get(off)?.type === 'controlEnd';
      let off = p.off;
      let beforeOk = true;
      for (let x = 0; x < off; x++) if (!isStart(x)) { beforeOk = false; break; }
      if (beforeOk && isStart(off)) {
        while (isStart(off)) off += 1;
        return {...p, off};
      }
      if (p.off === para.text.length && off >= 1 && isEnd(off - 1)) {
        const blockEnds = new Set(this.controlRanges(p.story).filter(r => samePath(r.end.path, p.path) && r.control.block).map(r => r.end.off));
        while (off >= 1 && isEnd(off - 1) && blockEnds.has(off - 1)) off -= 1;
        return {...p, off};
      }
      return {...p};
    },
  });
  void cmpPos;
}
