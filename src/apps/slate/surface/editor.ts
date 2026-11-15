// The page editor: a ProseMirror view over one page body, wired to the kernel (F:slate surface,
// docs/architecture.md 16.5).
//
// The schema is core/slate/schema.mjs (built headlessly), there is no editor history (the
// kernel's undo is the only one) and every document change the editor makes leaves through the
// `surface.edit` command as ProseMirror steps. The editor applies its own transactions at once
// (typing never waits for the kernel); the kernel echo of those steps is skipped, and any other
// change to the page (undo, a ribbon command, the bridge) rebuilds the editor from the kernel
// content with the kernel's selection.
//
// OneNote behaviour kept here: clicking on empty page space puts a caret there in a new, empty
// note container that only becomes part of the page when something is typed into it (clicking
// elsewhere first leaves no trace and no undo step); note containers show their top bar on hover,
// move by that bar and resize by the handle at its right end.

import {EditorState, TextSelection, NodeSelection, Selection, Plugin, type Transaction} from '@tiptap/pm/state';
import {EditorView, Decoration, DecorationSet, type NodeView} from '@tiptap/pm/view';
import {keymap} from '@tiptap/pm/keymap';
import {baseKeymap, chainCommands, createParagraphNear, splitBlockKeepMarks} from '@tiptap/pm/commands';
import {splitListItem} from '@tiptap/pm/schema-list';
import type {Node as PMNode} from '@tiptap/pm/model';
import type {Step} from '@tiptap/pm/transform';
import {schema, ID_NODES} from '../../../../core/slate/schema.mjs';
import {blockIndex, posToPoint, pointToPos, containerNode} from '../../../../core/slate/model/page.mjs';
import {shortId} from '../../../../core/kernel/host.mjs';
import {typeset} from '../../../../core/slate/lib/equation.mjs';
import {DiagramView, SpreadsheetView, type ObjectHooks} from './objectViews';
import {tagIcon} from '../../../../core/slate/lib/tags-catalog.mjs';
import {blockIssues} from '../../../../core/slate/lib/spelling.mjs';
import {icons} from '../../../generated/icons';
import {registerMediaElement, unregisterMediaElement} from '../../../shell/engine/mediaService';

export interface PageAddressPoint { anchor: string; focus: string }

/** Give every id-carrying node a unique id (split paragraphs copy their id; pasted nodes have none). */
export function idPlugin(): Plugin {
  return new Plugin({
    appendTransaction(trs, _old, state) {
      if (!trs.some(t => t.docChanged)) return null;
      const seen = new Set<string>();
      let tr: Transaction | null = null;
      state.doc.descendants((node, pos) => {
        if (!ID_NODES.has(node.type.name)) return true;
        const id = node.attrs.id;
        if (typeof id !== 'string' || !id || seen.has(id)) {
          const fresh = `${node.type.name === 'container' ? 'c' : 'b'}${shortId()}`;
          tr ??= state.tr;
          tr.setNodeAttribute(pos, 'id', fresh);
          seen.add(fresh);
        } else seen.add(id);
        return true;
      });
      return tr;
    },
  });
}

/** Address of a document position on a page (a caret in the textblock that holds it). */
export function pointAddress(pageId: string, doc: PMNode, pos: number): string {
  const p = posToPoint(doc, pos);
  return p ? `/pg:${pageId}/b:${p.blockId}/t:${p.offset}` : `/pg:${pageId}`;
}

/** The editor selection as kernel addresses. */
export function selectionAddresses(pageId: string, state: EditorState): PageAddressPoint {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.attrs?.id) {
    const n = sel.node;
    const kind = n.type.name === 'container' ? 'c' : n.isInline ? 'media' : 'b';
    const a = `/pg:${pageId}/${kind}:${n.attrs.id}`;
    return {anchor: a, focus: a};
  }
  const anchor = pointAddress(pageId, state.doc, sel.anchor);
  const focus = sel.anchor === sel.head ? anchor : pointAddress(pageId, state.doc, sel.head);
  return {anchor, focus};
}

/** Kernel address -> document position on this page (null when it names something else). */
export function addressToPos(pageId: string, doc: PMNode, address: string | undefined): {pos: number; node?: boolean} | null {
  if (!address) return null;
  const m = /^\/pg:([^/]+)\/(b|c|media):([^/]+)(?:\/t:(\d+)(?:-(\d+))?)?$/.exec(address);
  if (!m || decodeURIComponent(m[1]) !== pageId) return null;
  const id = decodeURIComponent(m[3]);
  const hit = blockIndex(doc).get(id);
  if (!hit) return null;
  if (m[4] !== undefined && hit.node.isTextblock) {
    try { return {pos: pointToPos(doc, id, Math.min(Number(m[4]), hit.node.content.size))}; } catch { return null; }
  }
  if (m[2] === 'b' && hit.node.isTextblock) return {pos: hit.pos + 1};
  return {pos: hit.pos, node: true};
}

/** An editor selection from kernel addresses (or the given fallback). */
export function selectionFrom(pageId: string, doc: PMNode, sel: {anchor?: string; focus?: string} | null, fallback?: Selection): Selection {
  const a = addressToPos(pageId, doc, sel?.anchor);
  const f = addressToPos(pageId, doc, sel?.focus) ?? a;
  try {
    if (a?.node && f?.node && a.pos === f.pos) return NodeSelection.create(doc, a.pos);
    if (a && f && !a.node && !f.node) return TextSelection.create(doc, a.pos, f.pos);
  } catch { /* fall through */ }
  if (fallback) {
    try { return Selection.fromJSON(doc, fallback.toJSON()); } catch { /* the old one no longer fits */ }
  }
  return Selection.atStart(doc);
}

export interface ContainerHooks extends ObjectHooks {
  /** A container's top bar was dragged to (x, y), or its handle set a width. */
  move(id: string, x: number, y: number): void;
  resize(id: string, width: number): void;
  /** Clicking a container's top bar selects the whole container (OneNote). */
  select(pos: number): void;
  zoom(): number;
  /** An equation's linear text was typed (Enter or leaving the box). */
  equation(id: string, linear: string): void;
  /** A link was clicked: open what it points at. */
  link(href: string): void;
  /** The box of a check box tag was clicked: check or uncheck it. */
  tagCheck(block: string, tag: string, checked: boolean): void;
  /** Stop on a recording that is running. */
  mediaStop(): void;
  /** Play the recording from the moment a note was typed (its play icon). */
  playFromNote(block: string): void;
}

/** A recording on the page: its player (audio or video, registered so the Audio & Video tab can drive it), or while it is being made a live "Recording" indicator with its time and a Stop button. */
class MediaView implements NodeView {
  dom: HTMLElement;
  private el: HTMLMediaElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private selected = false;
  constructor(private node: PMNode, _view: EditorView, _getPos: () => number | undefined, private hooks: ContainerHooks) {
    this.dom = document.createElement('span');
    this.dom.contentEditable = 'false';
    this.render();
  }
  private clear() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.el) { unregisterMediaElement(this.node.attrs.id, this.el); this.el.pause(); this.el = null; }
    this.dom.textContent = '';
  }
  private render() {
    this.clear();
    const a = this.node.attrs;
    const live = !a.src;
    this.dom.className = `slate-media is-${a.kind}${live ? ' is-recording' : ''}${this.selected ? ' is-selected' : ''}`;
    this.dom.dataset.id = a.id;
    this.dom.dataset.kind = a.kind;
    this.dom.setAttribute('aria-label', live ? `Recording ${a.kind}` : `${a.kind === 'video' ? 'Video' : 'Audio'} recording: ${a.name}`);
    const title = document.createElement('span');
    title.className = 'slate-media-title';
    title.textContent = a.name || (a.kind === 'video' ? 'Video recording' : 'Audio recording');
    this.dom.append(title);
    if (live) {
      // The recording's time and Stop live in the floating pill (one indicator); the page keeps a marker where the recording will sit.
      const dot = document.createElement('i'); dot.className = 'slate-rec-dot'; dot.setAttribute('aria-hidden', 'true');
      this.dom.prepend(dot);
      return;
    }
    const el = document.createElement(a.kind === 'video' ? 'video' : 'audio');
    el.controls = true; el.preload = 'metadata'; el.src = a.src;
    if (a.kind === 'video') (el as HTMLVideoElement).playsInline = true;
    el.className = 'slate-media-player';
    registerMediaElement(a.id, el);
    this.el = el;
    this.dom.append(el);
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    const a = this.node.attrs, b = node.attrs;
    const same = a.src === b.src && a.name === b.name && a.kind === b.kind && a.duration === b.duration && a.id === b.id;
    this.node = node;
    if (!same) this.render();
    return true;
  }
  selectNode() { this.selected = true; this.dom.classList.add('is-selected'); }
  deselectNode() { this.selected = false; this.dom.classList.remove('is-selected'); }
  stopEvent(e: Event) { return !!(e.target as Element | null)?.closest?.('audio, video, button'); }
  ignoreMutation() { return true; }
  destroy() { this.clear(); }
}

/** An equation on the page: the typeset form (MathML), or the linear text in a box while it is typed. */
class EquationView implements NodeView {
  dom: HTMLElement;
  private shown: HTMLElement;
  private input: HTMLInputElement | null = null;
  private selected = false;
  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined, private hooks: ContainerHooks) {
    this.dom = document.createElement('span');
    this.dom.className = 'slate-equation';
    this.dom.contentEditable = 'false';
    this.shown = document.createElement('span');
    this.shown.className = 'slate-equation-shown';
    this.dom.append(this.shown);
    this.dom.addEventListener('dblclick', e => { e.preventDefault(); this.edit(); });
    this.render();
  }
  private render() {
    const linear = String(this.node.attrs.linear ?? '');
    this.dom.dataset.id = this.node.attrs.id;
    this.dom.dataset.linear = linear;
    this.dom.setAttribute('aria-label', linear ? `Equation: ${linear}` : 'Equation: type here');
    if (linear.trim()) { this.shown.innerHTML = typeset({linear, format: this.node.attrs.format, normalText: this.node.attrs.normalText === true}); this.shown.classList.remove('is-empty'); }
    else { this.shown.textContent = 'Type equation here.'; this.shown.classList.add('is-empty'); }
  }
  private edit() {
    if (this.input) return;
    const input = document.createElement('input');
    input.className = 'slate-equation-input';
    input.value = String(this.node.attrs.linear ?? '');
    input.setAttribute('aria-label', 'Equation (linear format)');
    input.placeholder = 'Type equation here.';
    input.spellcheck = false;
    this.input = input;
    this.dom.classList.add('is-editing');
    this.dom.append(input);
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const value = input.value;
      this.input = null;
      input.remove();
      this.dom.classList.remove('is-editing');
      if (commit && value !== String(this.node.attrs.linear ?? '')) this.hooks.equation(this.node.attrs.id, value);
      this.view.focus();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', e => e.stopPropagation());
    setTimeout(() => input.focus(), 0);
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    const changed = node.attrs.linear !== this.node.attrs.linear;
    this.node = node;
    this.render();
    // The text changed somewhere else (undo, the bridge): the box has nothing more to commit.
    if (changed && this.input) { const box = this.input; this.input = null; box.remove(); this.dom.classList.remove('is-editing'); }
    if (this.selected && !String(node.attrs.linear ?? '').trim()) this.edit();
    return true;
  }
  selectNode() {
    this.selected = true;
    this.dom.classList.add('is-selected');
    // A new, empty equation is typed into at once, as OneNote's "Type equation here."
    if (!String(this.node.attrs.linear ?? '').trim()) this.edit();
  }
  deselectNode() { this.selected = false; this.dom.classList.remove('is-selected'); }
  stopEvent(e: Event) { return !!this.input && this.input.contains(e.target as Node); }
  ignoreMutation() { return true; }
}

/** Tab in a table: the next cell (the last cell adds a row), Shift+Tab the previous one. */
function cellMove(dir: 1 | -1) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const {$from} = state.selection;
    let depth = $from.depth;
    for (; depth > 0; depth--) if ($from.node(depth).type === schema.nodes.tableCell) break;
    if (depth === 0) return false;
    const table = $from.node(depth - 2);
    const rowIndex = $from.index(depth - 2), colIndex = $from.index(depth - 1);
    const rows = table.childCount, cols = table.child(rowIndex).childCount;
    let r = rowIndex, c = colIndex + dir;
    if (c >= cols) { c = 0; r++; }
    if (c < 0) { c = cols - 1; r--; }
    if (r < 0) return true;
    if (!dispatch) return true;
    const tablePos = $from.before(depth - 2);
    let tr = state.tr;
    if (r >= rows) {
      const row = schema.nodes.tableRow.create({id: `b${shortId()}`}, Array.from({length: cols}, () => schema.nodes.tableCell.create({id: `b${shortId()}`}, schema.nodes.paragraph.create({id: `b${shortId()}`}))));
      tr = tr.insert(tablePos + table.nodeSize - 1, row);
    }
    const t = tr.doc.nodeAt(tablePos)!;
    let pos = tablePos + 1;
    for (let i = 0; i < r; i++) pos += t.child(i).nodeSize;
    pos += 1;
    for (let i = 0; i < c; i++) pos += t.child(r).child(i).nodeSize;
    // The caret goes to the start of the next cell.
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Note container node view: an absolutely placed box with a top bar and a width handle. */
class ContainerView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private bar: HTMLElement;
  private handle: HTMLElement;
  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined, private hooks: ContainerHooks) {
    this.dom = document.createElement('div');
    this.dom.className = 'slate-container';
    this.bar = document.createElement('div');
    this.bar.className = 'slate-container-bar';
    this.bar.contentEditable = 'false';
    this.bar.setAttribute('aria-hidden', 'true');
    this.handle = document.createElement('div');
    this.handle.className = 'slate-container-resize';
    this.handle.contentEditable = 'false';
    this.handle.setAttribute('aria-hidden', 'true');
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'slate-container-body';
    this.dom.append(this.bar, this.handle, this.contentDOM);
    this.place(node);
    this.bar.addEventListener('pointerdown', e => this.drag(e, 'move'));
    this.handle.addEventListener('pointerdown', e => this.drag(e, 'resize'));
  }
  private place(node: PMNode) {
    const {x, y, width, id} = node.attrs;
    this.dom.dataset.id = id;
    this.dom.style.left = `${x}px`;
    this.dom.style.top = `${y}px`;
    if (width) { this.dom.style.width = `${width}px`; this.dom.classList.remove('is-auto'); }
    else { this.dom.style.removeProperty('width'); this.dom.classList.add('is-auto'); }
  }
  private drag(e: PointerEvent, kind: 'move' | 'resize') {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    try { target.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const zoom = this.hooks.zoom();
    const start = {x: e.clientX, y: e.clientY, left: this.node.attrs.x as number, top: this.node.attrs.y as number, width: this.dom.offsetWidth};
    let moved = false;
    const pos = this.getPos();
    if (kind === 'move' && pos !== undefined) this.hooks.select(pos);
    this.dom.classList.add('is-dragging');
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / zoom, dy = (ev.clientY - start.y) / zoom;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      moved = true;
      if (kind === 'move') { this.dom.style.left = `${Math.max(0, start.left + dx)}px`; this.dom.style.top = `${Math.max(0, start.top + dy)}px`; }
      else this.dom.style.width = `${Math.max(48, start.width + dx)}px`;
    };
    const onUp = (ev: PointerEvent) => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      this.dom.classList.remove('is-dragging');
      if (!moved) return;
      const dx = (ev.clientX - start.x) / zoom, dy = (ev.clientY - start.y) / zoom;
      if (kind === 'move') this.hooks.move(this.node.attrs.id, Math.max(0, Math.round(start.left + dx)), Math.max(0, Math.round(start.top + dy)));
      else this.hooks.resize(this.node.attrs.id, Math.max(48, Math.round(start.width + dx)));
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.place(node);
    return true;
  }
  selectNode() { this.dom.classList.add('is-selected'); }
  deselectNode() { this.dom.classList.remove('is-selected'); }
  stopEvent(e: Event) { const t = e.target as Node | null; return !!t && (this.bar.contains(t) || this.handle.contains(t)); }
  ignoreMutation(m: MutationRecord | {type: 'selection'; target: Node}) {
    if (m.type === 'selection') return false;
    const t = m.target as Node;
    return t === this.dom ? m.type === 'attributes' : this.bar.contains(t) || this.handle.contains(t);
  }
}

/**
 * Enter: split list items (an empty item leaves the list), else split the paragraph keeping the
 * typing marks. An empty line stays in its note container, as in OneNote (no lifting out).
 */
const enter = chainCommands((state, dispatch) => splitListItem(schema.nodes.listItem)(state, dispatch), createParagraphNear, splitBlockKeepMarks);

export interface PageEditorOptions {
  mount: HTMLElement;
  pageId: string;
  doc: PMNode;
  selection: {anchor?: string; focus?: string} | null;
  hooks: ContainerHooks;
  /** Steps the editor made (already applied locally); `label` for paste/cut/drop. */
  onSteps(steps: Step[], state: EditorState, meta: {typing: boolean; label?: string}): void;
  onSelection(state: EditorState): void;
  onFocusChange?(focused: boolean): void;
  /** Squiggles under misspelt words (U:slate/spelling): the shared spelling service and the document session whose Ignore lists apply. */
  spell?: {sp: any; session: string};
}

export interface PageEditor {
  view: EditorView;
  pageId: string;
  /** Replace the editor content with the kernel's (keeps the selection where it can). */
  reset(doc: PMNode, selection: {anchor?: string; focus?: string} | null): void;
  /** Start an empty note container at (x, y) with the caret in it; it is not on the page until typed into. */
  startContainer(x: number, y: number): void;
  /** The provisional container (not sent yet), or null. */
  provisional(): {id: string; steps: Step[]} | null;
  /** Drop the provisional container without a trace. */
  abandon(): void;
  /** Select a whole node (a container picked by its top bar). */
  selectNode(pos: number): void;
  /** Table cells the kernel selection names (Select Columns / Rows / Cell): drawn as selected. */
  setCells(ids: string[]): void;
  /** Caret at the start of the first note container (Enter in the title). */
  focusFirst(): boolean;
  /** Put the caret at a page point inside a note container (a click on its text); false when none is there. */
  caretAt(clientX: number, clientY: number): boolean;
  /** Type text at the caret as the keyboard would: each line inserted, Enter between lines (ui.type). */
  typeText(text: string): number;
  /** Draw the squiggles again (the spelling service has new answers). */
  refreshSpelling(): void;
  /** The page position under a window point, or null. */
  posAt(clientX: number, clientY: number): number | null;
  destroy(): void;
}

/** A paragraph's tags drawn in its left margin (the symbol of each, a check box as a box), and its highlight and font colour. */
function tagWidget(tags: any[], block: string, hooks: ContainerHooks, audio: {media: string; t: number} | null = null) {
  const wrap = document.createElement('span');
  wrap.className = 'slate-tags';
  wrap.contentEditable = 'false';
  if (audio) {
    // A note typed during a recording: its play icon starts the recording from that moment (OneNote's audio search by time).
    const a = document.createElement('span');
    a.className = 'slate-audio-note';
    a.dataset.context = 'audio-linked-paragraph';
    a.title = `Play the recording from this note (${Math.floor(audio.t / 60)}:${String(Math.floor(audio.t % 60)).padStart(2, '0')})`;
    a.setAttribute('role', 'button');
    a.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.5 5.2v5.6l4.4-2.8z" fill="currentColor"/></svg>';
    a.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); hooks.playFromNote(block); });
    wrap.append(a);
  }
  for (const t of tags) {
    const el = document.createElement('span');
    el.className = `slate-tag${t.checkbox ? ' is-checkbox' : ''}${t.checked ? ' is-checked' : ''}`;
    el.dataset.context = 'tag';
    el.dataset.tag = t.id;
    el.title = t.checkbox ? `${t.name} (click to ${t.checked ? 'uncheck' : 'check'})` : t.name;
    if (t.checkbox) {
      el.setAttribute('role', 'checkbox');
      el.setAttribute('aria-checked', String(!!t.checked));
      el.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2.2" fill="${t.checked ? '#fff' : 'none'}" stroke="currentColor" stroke-width="1.4"/>${t.checked ? '<path d="m4.7 8.2 2.3 2.4 4.4-5" fill="none" stroke="#c0392b" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>' : ''}</svg>`;
      el.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); hooks.tagCheck(block, t.id, !t.checked); });
    } else {
      const icon = tagIcon(t);
      const markup = (icons as Record<string, {d24: string}>)[icon]?.d24;
      if (markup) el.innerHTML = `<svg class="shell-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">${markup}</svg>`;
      else el.textContent = '•';
    }
    wrap.append(el);
  }
  return wrap;
}

export function createPageEditor(o: PageEditorOptions): PageEditor {
  let provisional: {id: string; steps: Step[]} | null = null;
  let cellIds = new Set<string>();
  const cellPlugin = new Plugin({
    props: {
      decorations(state) {
        if (!cellIds.size) return null;
        const list: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type === schema.nodes.tableCell && cellIds.has(node.attrs.id)) list.push(Decoration.node(pos, pos + node.nodeSize, {class: 'is-cell-selected'}));
          return !node.isTextblock;
        });
        return DecorationSet.create(state.doc, list);
      },
      // A click on a link follows it (OneNote); a drag selects text as usual.
      handleClick(_v, _pos, event) {
        const a = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!a || event.button !== 0) return false;
        event.preventDefault();
        o.hooks.link(a.getAttribute('href') ?? '');
        return true;
      },
    },
  });
  // Tags on paragraphs: the symbol beside the text, the tag's highlight and font colour on the text.
  const tagPlugin = new Plugin({
    props: {
      decorations(state) {
        const list: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type !== schema.nodes.paragraph) return true;
          const tags = (node.attrs.tags ?? []) as any[];
          const audio = node.attrs.audio as {media: string; t: number} | null;
          if (tags.length || audio) {
            const hl = tags.find(t => t.highlightColor)?.highlightColor, fc = tags.find(t => t.fontColor)?.fontColor;
            const style = [hl ? `background:${hl}` : '', fc ? `color:${fc}` : ''].filter(Boolean).join(';');
            list.push(Decoration.node(pos, pos + node.nodeSize, {class: 'has-tags', ...(style ? {style} : {})}));
            list.push(Decoration.widget(pos + 1, () => tagWidget(tags, node.attrs.id, o.hooks, audio), {side: -1, key: `tags-${node.attrs.id}-${JSON.stringify(tags.map(t => [t.id, t.checked]))}-${audio ? audio.t : ''}`, ignoreSelection: true}));
          }
          return false;
        });
        return DecorationSet.create(state.doc, list);
      },
    },
  });
  // Spelling squiggles: a red wavy underline under each misspelt word; a block is read again only when it changed (nodes are immutable) or the service has new answers.
  const spellMemo = new WeakMap<object, {v: number; list: {start: number; end: number; word: string}[]}>();
  const spellPlugin = new Plugin({
    props: {
      decorations(state) {
        const sp = o.spell?.sp;
        if (!sp) return null;
        const list: Decoration[] = [];
        const caret = state.selection.empty ? state.selection.from : -1;
        state.doc.descendants((node, pos) => {
          if (!node.isTextblock) return true;
          let hit = spellMemo.get(node);
          if (!hit || hit.v !== sp.version) { hit = {v: sp.version, list: blockIssues(node, sp, {session: o.spell!.session, page: o.pageId})}; spellMemo.set(node, hit); }
          for (const t of hit.list) {
            const a = pos + 1 + t.start, b = pos + 1 + t.end;
            // The word being typed has no squiggle until the caret leaves it.
            if (caret === b && view.hasFocus()) continue;
            list.push(Decoration.inline(a, b, {class: 'slate-misspelt', 'data-word': t.word}));
          }
          return false;
        });
        return DecorationSet.create(state.doc, list);
      },
    },
  });
  const plugins = [idPlugin(), cellPlugin, tagPlugin, spellPlugin, keymap({Enter: enter, Tab: cellMove(1), 'Shift-Tab': cellMove(-1)}), keymap(baseKeymap)];
  const make = (doc: PMNode, sel: Selection) => EditorState.create({schema, doc, plugins, selection: sel});

  const view: EditorView = new EditorView(o.mount, {
    state: make(o.doc, selectionFrom(o.pageId, o.doc, o.selection)),
    attributes: {class: 'slate-editor-root', spellcheck: 'true', 'aria-label': 'Page notes', role: 'textbox', 'aria-multiline': 'true'},
    nodeViews: {
      container: (node, v, getPos) => new ContainerView(node, v, getPos, o.hooks),
      equation: (node, v, getPos) => new EquationView(node, v, getPos, o.hooks),
      media: (node, v, getPos) => new MediaView(node, v, getPos, o.hooks),
      spreadsheet: (node, v, getPos) => new SpreadsheetView(node, v, getPos, o.hooks),
      diagram: (node, v, getPos) => new DiagramView(node, v, getPos, o.hooks),
    },
    dispatchTransaction(tr) {
      const {state: next, transactions} = view.state.applyTransaction(tr);
      view.updateState(next);
      const steps = transactions.flatMap(t => t.steps);
      if (steps.length) {
        if (provisional && tr.getMeta('slateProvisional')) { provisional.steps.push(...steps); return; }
        let all = steps;
        if (provisional) {
          // The first edit inside (or anywhere) commits the container that was waiting for it.
          all = [...provisional.steps, ...steps];
          provisional = null;
        }
        const ui = transactions.map(t => t.getMeta('uiEvent')).find(Boolean) as string | undefined;
        o.onSteps(all, next, {typing: !ui, label: ui === 'paste' ? 'Paste' : ui === 'cut' ? 'Cut' : ui === 'drop' ? 'Move' : undefined});
        return;
      }
      if (provisional && tr.selectionSet && !insideProvisional(next)) { abandonNow(); return; }
      if (tr.selectionSet) o.onSelection(next);
    },
    handleDOMEvents: {
      focus: () => { o.onFocusChange?.(true); return false; },
      blur: (_v, e) => {
        o.onFocusChange?.(false);
        const to = (e as FocusEvent).relatedTarget as Node | null;
        if (provisional && !(to && view.dom.contains(to))) setTimeout(() => { if (provisional && !view.hasFocus()) abandonNow(); }, 0);
        return false;
      },
    },
  });

  function insideProvisional(state: EditorState) {
    if (!provisional) return false;
    const hit = blockIndex(state.doc).get(provisional.id);
    if (!hit) return false;
    const {from, to} = state.selection;
    return from > hit.pos && to < hit.pos + hit.node.nodeSize;
  }

  function abandonNow() {
    if (!provisional) return;
    const p = provisional;
    provisional = null;
    const hit = blockIndex(view.state.doc).get(p.id);
    if (!hit) return;
    // Remove it locally: the kernel never saw it.
    const tr = view.state.tr.delete(hit.pos, hit.pos + hit.node.nodeSize).setMeta('addToHistory', false);
    const next = view.state.apply(tr);
    view.updateState(next);
    o.onSelection(next);
  }

  return {
    view,
    pageId: o.pageId,
    reset(doc, selection) {
      provisional = null;
      if (doc.eq(view.state.doc)) {
        // The selection must belong to the editor's own doc object (an equal doc from the kernel is another instance).
        const sel = selectionFrom(o.pageId, view.state.doc, selection, view.state.selection);
        if (!sel.eq(view.state.selection)) view.updateState(view.state.apply(view.state.tr.setSelection(sel)));
        return;
      }
      view.updateState(make(doc, selectionFrom(o.pageId, doc, selection, view.state.selection)));
    },
    setCells(ids) {
      const next = new Set(ids);
      if (next.size === cellIds.size && [...next].every(i => cellIds.has(i))) return;
      cellIds = next;
      view.dispatch(view.state.tr.setMeta('slateCells', true).setMeta('addToHistory', false));
    },
    startContainer(x, y) {
      abandonNow();
      const id = `c${shortId()}`;
      const node = containerNode({id, x: Math.round(x), y: Math.round(y), width: null, text: ''}, () => `b${shortId()}`);
      provisional = {id, steps: []};
      const end = view.state.doc.content.size;
      const tr = view.state.tr.insert(end, node).setMeta('slateProvisional', true);
      tr.setSelection(TextSelection.create(tr.doc, end + 2));
      view.dispatch(tr);
      view.focus();
    },
    provisional: () => provisional,
    abandon: abandonNow,
    selectNode(pos) {
      try { view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos))); view.focus(); } catch { /* not a node */ }
    },
    focusFirst() {
      const first = view.state.doc.firstChild;
      if (!first) return false;
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(2))));
      view.focus();
      return true;
    },
    caretAt(clientX, clientY) {
      const hit = view.posAtCoords({left: clientX, top: clientY});
      if (!hit) return false;
      const $pos = view.state.doc.resolve(hit.pos);
      if (!$pos.parent.isTextblock) return false;
      abandonNow();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, hit.pos)));
      view.focus();
      return true;
    },
    typeText(text) {
      const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
      let typed = 0;
      lines.forEach((line, i) => {
        if (i > 0) { enter(view.state, view.dispatch); typed++; }
        if (line) { view.dispatch(view.state.tr.insertText(line)); typed += line.length; }
      });
      return typed;
    },
    refreshSpelling() { try { view.dispatch(view.state.tr.setMeta('slateSpell', true)); } catch { /* the view is gone */ } },
    posAt(clientX, clientY) { return view.posAtCoords({left: clientX, top: clientY})?.pos ?? null; },
    destroy() { view.destroy(); },
  };
}
