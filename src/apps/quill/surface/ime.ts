// Text input for the Quill page view: the EditContext API (Chromium) with IME composition, or, when
// EditContext is missing, a hidden textarea. Either way typed text reaches the document only through
// the kernel's text.insert (one "Typing" undo step per burst), and a composition is shown as preedit
// (an underlined overlay at the caret) until it is committed.
//
// Upstream: wordcraft crates/ui-egui/src/canvas.rs (`update_canvas_focus`: the IME rectangle and
// the preedit), crates/engine/src/session (ime_surrounding / ime_delete_surrounding through
// crates/doc/src/ime_text.rs, translated in core/quill/model/ime-text.mjs) at ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c. EditContext replaces egui's IME events: the IME sees a
// bounded window of the caret paragraph's visible text (`imeSurrounding`), and an edit the IME makes
// to that window is mapped back to stored offsets (`VisibleParagraph.storedOffset`).
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {imeSurrounding, VisibleParagraph} from '../../../../core/quill/model/ime-text.mjs';

export interface Pos { story: 'body' | number; path: number[]; off: number }
export interface Preedit { text: string; caret: number; segments: {start: number; end: number; thick: boolean}[] }

export interface ImeHost {
  /** The model Document and selection the IME window is built from. */
  read(): {doc: any; anchor: Pos; focus: Pos} | null;
  /** Run a command (text.insert, select.range, text.delete …) as the person did. */
  run(id: string, params: Record<string, unknown>): Promise<unknown>;
  /** The preedit changed (null when the composition ended). */
  preedit(p: Preedit | null): void;
  /** Client rect of the caret (for the IME candidate window). */
  caretRect(): DOMRect | null;
}

declare const EditContext: any;

const samePara = (a: Pos, b: Pos) => a.story === b.story && a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i]);

/** The IME window over the caret paragraph: its text and the stored offset of each visible offset. */
function windowOf(doc: any, anchor: Pos, focus: Pos) {
  if (!samePara(anchor, focus)) return null;
  const para = doc.paraAt(focus);
  if (!para) return null;
  const w = imeSurrounding(doc, focus, anchor);
  if (!w) return null;
  const view = new VisibleParagraph(para);
  const cVis = view.visibleOffset(focus.off);
  if (cVis === null) return null;
  const base = cVis - w.cursor;
  return {text: w.text as string, cursor: w.cursor as number, anchor: w.anchor as number, base, view, pos: focus};
}

export class TextInput {
  readonly native: boolean;
  private el: HTMLElement;
  private host: ImeHost;
  private ec: any = null;
  private area: HTMLTextAreaElement | null = null;
  private win: ReturnType<typeof windowOf> = null;
  private composing = false;
  private compStart = 0;
  private compText = '';
  private compSel: {anchor: Pos; focus: Pos} | null = null;
  private segments: Preedit['segments'] = [];
  private offs: (() => void)[] = [];

  constructor(el: HTMLElement, host: ImeHost) {
    this.el = el;
    this.host = host;
    this.native = typeof EditContext === 'function';
    if (this.native) this.attachEditContext();
    else this.attachTextarea();
  }

  dispose() {
    for (const f of this.offs) f();
    this.offs = [];
    if (this.ec) { try { (this.el as any).editContext = null; } catch { /* already detached */ } }
    this.area?.remove();
  }

  /** The element that takes keyboard focus. */
  focusTarget(): HTMLElement { return this.area ?? this.el; }
  isComposing() { return this.composing; }

  /** Re-read the caret paragraph into the IME window (after every commit or selection change). */
  sync() {
    if (this.composing) return;
    const r = this.host.read();
    this.win = r ? windowOf(r.doc, r.anchor, r.focus) : null;
    const text = this.win?.text ?? '';
    if (this.ec) {
      this.ec.updateText(0, this.ec.text.length, text);
      const a = this.win?.anchor ?? 0, c = this.win?.cursor ?? 0;
      this.ec.updateSelection(Math.min(a, c), Math.max(a, c));
    }
    this.bounds();
  }

  /** Tell the IME where the caret is (candidate window placement). */
  bounds() {
    if (!this.ec) return;
    const box = this.el.getBoundingClientRect();
    const caret = this.host.caretRect() ?? new DOMRect(box.x, box.y, 1, 16);
    try {
      this.ec.updateControlBounds(box);
      this.ec.updateSelectionBounds(caret);
    } catch { /* detached */ }
  }

  private on(target: EventTarget, type: string, f: (e: any) => void) {
    target.addEventListener(type, f);
    this.offs.push(() => target.removeEventListener(type, f));
  }

  private attachEditContext() {
    const ec = new EditContext();
    this.ec = ec;
    (this.el as any).editContext = ec;
    this.on(ec, 'compositionstart', () => {
      this.composing = true;
      const r = this.host.read();
      this.compSel = r ? {anchor: r.anchor, focus: r.focus} : null;
      this.compStart = Math.min(ec.selectionStart, ec.selectionEnd);
      this.compText = '';
      this.segments = [];
    });
    this.on(ec, 'textupdate', (e: any) => {
      if (this.composing) {
        this.compStart = e.updateRangeStart;
        this.compText = String(e.text ?? '');
        this.host.preedit({text: this.compText, caret: Math.max(0, (e.selectionStart ?? 0) - this.compStart), segments: this.segments});
        return;
      }
      void this.apply(e.updateRangeStart, e.updateRangeEnd, String(e.text ?? ''));
    });
    this.on(ec, 'textformatupdate', (e: any) => {
      const formats = typeof e.getTextFormats === 'function' ? e.getTextFormats() : [];
      this.segments = formats.map((f: any) => ({start: f.rangeStart - this.compStart, end: f.rangeEnd - this.compStart,
        thick: String(f.underlineThickness ?? '').toLowerCase() === 'thick'}));
      if (this.composing) this.host.preedit({text: this.compText, caret: this.compText.length, segments: this.segments});
    });
    this.on(ec, 'characterboundsupdate', (e: any) => {
      const caret = this.host.caretRect();
      if (!caret) return;
      const n = Math.max(0, e.rangeEnd - e.rangeStart);
      try { ec.updateCharacterBounds(e.rangeStart, Array.from({length: n}, () => caret)); } catch { /* detached */ }
    });
    this.on(ec, 'compositionend', () => {
      const text = this.compText;
      this.composing = false;
      this.host.preedit(null);
      void this.commitComposition(text);
    });
  }

  private async commitComposition(text: string) {
    const sel = this.compSel;
    this.compSel = null;
    if (text) {
      if (sel) await this.host.run('select.range', {anchor: sel.anchor, focus: sel.focus});
      await this.host.run('text.insert', {text});
    }
    this.sync();
  }

  /** An edit the IME (or plain typing) made to the window, applied to the document. */
  private async apply(start: number, end: number, text: string) {
    const w = this.win;
    const r = this.host.read();
    if (!r) return;
    const selStart = Math.min(w?.anchor ?? 0, w?.cursor ?? 0), selEnd = Math.max(w?.anchor ?? 0, w?.cursor ?? 0);
    const replacesSelection = !w || (start === selStart && end === selEnd);
    if (!replacesSelection && w) {
      const a = w.view.storedOffset(w.base + start), b = w.view.storedOffset(w.base + end);
      if (a === null || b === null) { this.sync(); return; }
      await this.host.run('select.range', {anchor: {...w.pos, off: a}, focus: {...w.pos, off: b}});
    }
    if (text) await this.host.run('text.insert', {text});
    else if (end > start) await this.host.run('text.delete', {});
    this.sync();
  }

  private attachTextarea() {
    const area = document.createElement('textarea');
    area.className = 'quill-input-fallback';
    area.setAttribute('aria-hidden', 'true');
    area.tabIndex = -1;
    area.autocapitalize = 'off';
    area.spellcheck = false;
    this.el.appendChild(area);
    this.area = area;
    this.on(area, 'compositionstart', () => {
      this.composing = true;
      const r = this.host.read();
      this.compSel = r ? {anchor: r.anchor, focus: r.focus} : null;
    });
    this.on(area, 'compositionupdate', (e: CompositionEvent) => {
      this.compText = e.data ?? '';
      this.host.preedit({text: this.compText, caret: this.compText.length, segments: [{start: 0, end: this.compText.length, thick: false}]});
    });
    this.on(area, 'compositionend', (e: CompositionEvent) => {
      this.composing = false;
      this.host.preedit(null);
      area.value = '';
      void this.commitComposition(e.data ?? '');
    });
    this.on(area, 'beforeinput', (e: InputEvent) => {
      if (this.composing || e.isComposing) return;
      if (e.inputType === 'insertText' && e.data) { e.preventDefault(); void this.host.run('text.insert', {text: e.data}); }
      else if (e.inputType === 'insertReplacementText' && e.data) { e.preventDefault(); void this.host.run('text.insert', {text: e.data}); }
      // The textarea is a field, so KeyRouter leaves its editing keys to it: run them here.
      else if (e.inputType === 'insertParagraph') { e.preventDefault(); void this.host.run('text.newParagraph', {}); }
      else if (e.inputType === 'insertLineBreak') { e.preventDefault(); void this.host.run('text.lineBreak', {}); }
      else if (e.inputType === 'deleteContentBackward') { e.preventDefault(); void this.host.run('text.backspace', {}); }
      else if (e.inputType === 'deleteContentForward') { e.preventDefault(); void this.host.run('text.delete', {}); }
      else if (e.inputType === 'deleteWordBackward') { e.preventDefault(); void this.host.run('text.deleteWordBack', {}); }
      else if (e.inputType === 'deleteWordForward') { e.preventDefault(); void this.host.run('text.deleteWordForward', {}); }
    });
  }
}
