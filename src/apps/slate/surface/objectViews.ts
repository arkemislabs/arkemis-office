// A worksheet and a diagram on the page (U:slate/rest): the node views of `spreadsheet` and `diagram`.
//
// The worksheet is a grid of cells with column letters and row numbers. A cell is chosen with a click or the arrow keys
// while the worksheet is selected; Enter, F2, a double-click or typing starts editing it (the box holds what was typed,
// `=SUM(A1:A3)` for a formula) and Enter, Tab or leaving the box keeps it; Esc leaves it as it was; Delete clears the cell.
// Two buttons with a plus add a column and a row. Every change is a command (spreadsheet.setCell, spreadsheet.resize), so
// it is one undo step and the bridge sees it. The diagram is the SVG the app draws from its outline; a double-click opens
// its dialog. No script or markup from the page is ever put in: text is set with textContent and the SVG is built by
// core/slate/lib/diagram.mjs, which escapes every label.

import type {EditorView, NodeView} from '@tiptap/pm/view';
import type {Node as PMNode} from '@tiptap/pm/model';
import {drawDiagram} from '../../../../core/slate/lib/diagram.mjs';
import {shownAt} from '../../../../core/slate/lib/sheet-text.mjs';

export interface ObjectHooks {
  sheetCell(id: string, ref: string, text: string): void;
  sheetResize(id: string, rows: number, cols: number): void;
  diagramOpen(id: string): void;
}

const letters = (c: number) => String.fromCharCode(65 + c);
const refOf = (r: number, c: number) => `${letters(c)}${r + 1}`;

export class SpreadsheetView implements NodeView {
  dom: HTMLElement;
  private table: HTMLTableElement;
  private active = {row: 0, col: 0};
  private selected = false;
  private input: HTMLInputElement | null = null;
  private onKey = (e: KeyboardEvent) => this.key(e);
  constructor(private node: PMNode, private view: EditorView, _getPos: () => number | undefined, private hooks: ObjectHooks) {
    this.dom = document.createElement('span');
    this.dom.className = 'slate-sheet';
    this.dom.contentEditable = 'false';
    this.table = document.createElement('table');
    this.table.className = 'slate-sheet-grid';
    this.table.setAttribute('role', 'grid');
    this.dom.append(this.table);
    this.dom.addEventListener('mousedown', e => {
      const td = (e.target as Element | null)?.closest?.('td[data-ref]') as HTMLElement | null;
      if (td) { this.active = {row: Number(td.dataset.row), col: Number(td.dataset.col)}; this.paintActive(); }
    });
    this.dom.addEventListener('dblclick', e => {
      const td = (e.target as Element | null)?.closest?.('td[data-ref]') as HTMLElement | null;
      if (td) { e.preventDefault(); this.active = {row: Number(td.dataset.row), col: Number(td.dataset.col)}; this.edit(null); }
    });
    this.render();
  }
  private get id(): string { return this.node.attrs.id; }
  private render() {
    const a = this.node.attrs;
    this.dom.dataset.id = a.id;
    this.dom.setAttribute('aria-label', `Spreadsheet, ${a.rows} rows by ${a.cols} columns${a.title ? `: ${a.title}` : ''}`);
    this.active = {row: Math.min(this.active.row, a.rows - 1), col: Math.min(this.active.col, a.cols - 1)};
    this.table.textContent = '';
    const head = this.table.createTHead().insertRow();
    head.insertCell().className = 'slate-sheet-corner';
    for (let c = 0; c < a.cols; c++) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = letters(c); head.append(th); }
    if (a.cols < 26) {
      const add = document.createElement('th');
      add.className = 'slate-sheet-add-col';
      add.append(this.plus('Add a column', () => this.hooks.sheetResize(this.id, a.rows, a.cols + 1)));
      head.append(add);
    }
    const body = this.table.createTBody();
    for (let r = 0; r < a.rows; r++) {
      const tr = body.insertRow();
      const th = document.createElement('th'); th.scope = 'row'; th.textContent = String(r + 1); tr.append(th);
      for (let c = 0; c < a.cols; c++) {
        const td = tr.insertCell();
        td.dataset.ref = refOf(r, c); td.dataset.row = String(r); td.dataset.col = String(c);
        td.setAttribute('role', 'gridcell');
        const text = shownAt(a, r, c);
        td.textContent = text;
        const raw = a.cells?.[refOf(r, c)] ?? '';
        if (raw.startsWith('=')) td.classList.add('is-formula');
        if (text !== '' && /^-?[\d.,]+%?$|^\$?-?[\d.,]+$/.test(text)) td.classList.add('is-number');
        if (/^#[A-Z0-9/!?]+$/.test(text)) td.classList.add('is-error');
      }
    }
    if (a.rows < 100) {
      const tr = body.insertRow();
      tr.className = 'slate-sheet-add-row';
      const td = tr.insertCell();
      td.colSpan = a.cols + 1;
      td.append(this.plus('Add a row', () => this.hooks.sheetResize(this.id, a.rows + 1, a.cols)));
    }
    this.paintActive();
  }
  private plus(label: string, run: () => void) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'slate-sheet-plus'; b.title = label; b.setAttribute('aria-label', label);
    b.innerHTML = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M5 1v8M1 5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>';
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); run(); });
    return b;
  }
  private cell(row: number, col: number): HTMLElement | null { return this.table.querySelector(`td[data-ref="${refOf(row, col)}"]`); }
  private paintActive() {
    this.table.querySelectorAll('.is-active').forEach(n => n.classList.remove('is-active'));
    if (this.selected || this.input) this.cell(this.active.row, this.active.col)?.classList.add('is-active');
  }
  private edit(first: string | null) {
    if (this.input) return;
    const td = this.cell(this.active.row, this.active.col);
    if (!td) return;
    const ref = refOf(this.active.row, this.active.col);
    const input = document.createElement('input');
    input.className = 'slate-sheet-input';
    input.value = first ?? String(this.node.attrs.cells?.[ref] ?? '');
    input.spellcheck = false;
    input.setAttribute('aria-label', `Cell ${ref}`);
    this.input = input;
    td.textContent = '';
    td.classList.add('is-editing');
    td.append(input);
    let done = false;
    const finish = (commit: boolean, dr = 0, dc = 0) => {
      if (done) return;
      done = true;
      const value = input.value;
      this.input = null;
      td.classList.remove('is-editing');
      const a = this.node.attrs;
      this.active = {row: Math.max(0, Math.min(a.rows - 1, this.active.row + dr)), col: Math.max(0, Math.min(a.cols - 1, this.active.col + dc))};
      this.render();
      if (commit && value !== String(this.node.attrs.cells?.[ref] ?? '')) this.hooks.sheetCell(this.id, ref, value);
      this.view.focus();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1, 0); }
      else if (e.key === 'Tab') { e.preventDefault(); finish(true, 0, e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', e => e.stopPropagation());
    input.addEventListener('mousedown', e => e.stopPropagation());
    setTimeout(() => { input.focus(); if (first === null) input.select(); else input.setSelectionRange(input.value.length, input.value.length); }, 0);
  }
  private key(e: KeyboardEvent) {
    if (!this.selected || this.input || e.ctrlKey || e.metaKey || e.altKey) return;
    const a = this.node.attrs;
    const move = (dr: number, dc: number) => { this.active = {row: Math.max(0, Math.min(a.rows - 1, this.active.row + dr)), col: Math.max(0, Math.min(a.cols - 1, this.active.col + dc))}; this.paintActive(); };
    if (e.key === 'ArrowUp') move(-1, 0);
    else if (e.key === 'ArrowDown') move(1, 0);
    else if (e.key === 'ArrowLeft') move(0, -1);
    else if (e.key === 'ArrowRight') move(0, 1);
    else if (e.key === 'Enter' || e.key === 'F2') this.edit(null);
    else if (e.key === 'Delete' || e.key === 'Backspace') { const ref = refOf(this.active.row, this.active.col); if (a.cells?.[ref]) this.hooks.sheetCell(this.id, ref, ''); }
    else if (e.key.length === 1) { this.edit(e.key); } else return;
    e.preventDefault(); e.stopPropagation();
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    // The input is gone when the sheet changes under it (undo, the bridge); what it held is dropped.
    this.input = null;
    this.render();
    return true;
  }
  selectNode() { this.selected = true; this.dom.classList.add('is-selected'); this.view.dom.addEventListener('keydown', this.onKey, true); this.paintActive(); }
  deselectNode() { this.selected = false; this.dom.classList.remove('is-selected'); this.view.dom.removeEventListener('keydown', this.onKey, true); this.paintActive(); }
  stopEvent(e: Event) { const t = e.target as Element | null; return !!t?.closest?.('input, button'); }
  ignoreMutation() { return true; }
  destroy() { this.view.dom.removeEventListener('keydown', this.onKey, true); }
}

export class DiagramView implements NodeView {
  dom: HTMLElement;
  constructor(private node: PMNode, _view: EditorView, _getPos: () => number | undefined, private hooks: ObjectHooks) {
    this.dom = document.createElement('span');
    this.dom.className = 'slate-diagram';
    this.dom.contentEditable = 'false';
    this.dom.addEventListener('dblclick', e => { e.preventDefault(); this.hooks.diagramOpen(this.node.attrs.id); });
    this.render();
  }
  private render() {
    const a = this.node.attrs;
    this.dom.dataset.id = a.id;
    this.dom.dataset.kind = a.kind;
    const d = drawDiagram(a.kind, a.text);
    this.dom.setAttribute('aria-label', d.nodes ? `Diagram: ${a.kind}, ${d.nodes} boxes` : 'Diagram: empty');
    // The SVG is made by drawDiagram from escaped text only.
    if (d.svg) this.dom.innerHTML = d.svg; else this.dom.textContent = 'Empty diagram';
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  selectNode() { this.dom.classList.add('is-selected'); }
  deselectNode() { this.dom.classList.remove('is-selected'); }
  ignoreMutation() { return true; }
}
