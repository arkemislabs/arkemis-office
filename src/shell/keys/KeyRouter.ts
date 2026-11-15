// Keyboard routing (docs/architecture.md section 11).
//
// One capture-phase keydown listener on the window resolves, in order: an open dialog's scope,
// keytip mode, the surface scope (contextual flags such as `table` or `equation`), then the app
// scope. Bindings come from the spec's `shortcuts`, the controls' `shortcut` and the commands'
// `shortcut`; `Mod` is Ctrl on Windows/Linux and Cmd on macOS. The surface handles plain text
// input itself: the router only claims chords and named keys that have a binding. `ui.key` on the
// bridge feeds `feed()` directly, so no OS or synthetic DOM input is ever needed.
//
// The routing core is pure (no DOM at module level); `attach()` wires it to a window.

import {parseShortcut, formatChord} from '../../../core/kernel/command.mjs';
import type {Chord, ParsedShortcut} from '../../../core/kernel/command.mjs';

export type Platform = 'mac' | 'win' | 'linux';
/** 'app' always applies; any other scope is a contextual flag that must hold (or 'dialog'). */
export type Scope = string;

export interface Binding {
  keys: string;                         // as written ('Mod+B', 'Ctrl+V / Shift+Insert', 'Alt, H, F, F')
  command?: string | null;
  dialog?: string | null;
  args?: Record<string, unknown> | null;
  scope: Scope;
  source: 'spec' | 'control' | 'command' | 'shell';
  /** Control id when it came from a ribbon control (keytips and inspection). */
  control?: string;
}

export interface KeyLike { key: string; code?: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean; repeat?: boolean }

const NAMED: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Spacebar: 'Space', Esc: 'Escape',
  Del: 'Delete', ContextMenu: 'Menu', Apps: 'Menu', OS: 'Meta', Control: 'Ctrl', AltGraph: 'Alt',
};
const MODIFIER_KEYS = new Set(['Ctrl', 'Alt', 'Shift', 'Meta']);

/** The chord a keydown represents (null for a bare modifier or a dead key). */
export function chordFromEvent(e: KeyLike): Chord | null {
  let key = NAMED[e.key] ?? e.key;
  if (!key || key === 'Dead' || key === 'Unidentified' || key === 'Process') return null;
  const ctrl = !!e.ctrlKey, alt = !!e.altKey, shift = !!e.shiftKey, meta = !!e.metaKey;
  // With Ctrl/Alt/Cmd held, letters and digits come from the physical key (Option+B on macOS types "∫").
  if ((ctrl || alt || meta) && e.code) {
    const m = /^Key([A-Z])$/.exec(e.code) || /^Digit([0-9])$/.exec(e.code);
    if (m) key = m[1];
  }
  if (e.code && /^Numpad[0-9]$/.test(e.code) && !ctrl && !alt && !meta) key = 'Num' + e.code.slice(-1);
  if (key.length === 1) key = key.toUpperCase();
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) key = key.toUpperCase();
  if (MODIFIER_KEYS.has(key)) return {ctrl: false, alt: false, shift: false, meta: false, mod: false, key};
  return {ctrl, alt, shift, meta, mod: false, key};
}

/** Canonical text of a chord on a platform ('Ctrl+Shift+B'); Mod resolves to Ctrl or Meta. */
export const chordText = (c: Chord, platform: Platform) => formatChord(c, platform);
export const isBareModifier = (c: Chord | null) => !!c && MODIFIER_KEYS.has(c.key) && !c.ctrl && !c.alt && !c.shift && !c.meta && !c.mod;

/** Parse a binding's keys into canonical step lists (alternatives, each a sequence of chords). */
export function bindingSteps(keys: string, platform: Platform): string[][] {
  return parseShortcut(keys).filter((p: ParsedShortcut) => p.steps).map((p: ParsedShortcut) => p.steps!.map(c => chordText(c, platform)));
}

export interface RouterOptions {
  platform: Platform;
  bindings: Binding[];
  /** Whether a scope applies now ('app' always does). */
  scopeActive?: (scope: Scope) => boolean;
  /**
   * Highest-priority scope: an open dialog claims keys first. Return true when it handled the key,
   * 'pass' when a modal dialog owns the keyboard (app shortcuts must not run behind it, but the key
   * still reaches the dialog's fields), false when no dialog is open.
   */
  dialog?: (chord: Chord, text: string) => boolean | 'pass';
  /** Keytip mode: return true when handled (it swallows every key while active). */
  keytips?: {active(): boolean; key(chord: Chord, text: string): boolean; toggle(): void};
  /** Runs a binding. */
  run: (b: Binding) => void;
  /** Sequence timeout (ms) between steps of a key sequence. */
  sequenceMs?: number;
  now?: () => number;
}

export interface RouteResult { handled: boolean; binding?: Binding; scope?: 'dialog' | 'keytips' | 'surface' | 'app' | 'sequence' }

/** The router: canonical tables per scope, sequence state, Alt-tap detection. */
export class KeyRouter {
  readonly platform: Platform;
  private opts: RouterOptions;
  private tables = new Map<Scope, Map<string, Binding>>();
  private sequences: {steps: string[]; binding: Binding}[] = [];
  private prefix: string[] = [];
  private prefixAt = 0;
  private altArmed = false;
  readonly conflicts: {scope: Scope; keys: string; a: Binding; b: Binding}[] = [];

  constructor(opts: RouterOptions) {
    this.opts = opts;
    this.platform = opts.platform;
    this.setBindings(opts.bindings);
  }

  /** Rebuild the tables (spec shortcuts win over control shortcuts, which win over command defaults). */
  setBindings(bindings: Binding[]) {
    this.tables.clear();
    this.sequences = [];
    this.conflicts.length = 0;
    const rank = {spec: 0, shell: 1, control: 2, command: 3} as const;
    const sorted = [...bindings].sort((a, b) => rank[a.source] - rank[b.source]);
    for (const b of sorted) {
      for (const steps of bindingSteps(b.keys, this.platform)) {
        if (steps.length > 1) { this.sequences.push({steps, binding: b}); continue; }
        const text = steps[0];
        let table = this.tables.get(b.scope);
        if (!table) this.tables.set(b.scope, table = new Map());
        const prev = table.get(text);
        if (prev) {
          if (prev.source === b.source && (prev.command !== b.command || prev.dialog !== b.dialog || JSON.stringify(prev.args ?? null) !== JSON.stringify(b.args ?? null))) {
            this.conflicts.push({scope: b.scope, keys: text, a: prev, b});
          }
          continue;
        }
        table.set(text, b);
      }
    }
  }

  /** The binding a chord resolves to now (scopes in order: surface flags, then app). */
  lookup(text: string): {binding: Binding; scope: 'surface' | 'app'} | null {
    const active = this.opts.scopeActive ?? (() => false);
    for (const [scope, table] of this.tables) {
      if (scope === 'app' || scope === 'dialog') continue;
      const b = table.get(text);
      if (b && active(scope)) return {binding: b, scope: 'surface'};
    }
    const b = this.tables.get('app')?.get(text);
    return b ? {binding: b, scope: 'app'} : null;
  }

  /** Every binding that is reachable now (inspection, tooltips). */
  list(): Binding[] {
    const out: Binding[] = [];
    for (const table of this.tables.values()) for (const b of table.values()) if (!out.includes(b)) out.push(b);
    for (const s of this.sequences) if (!out.includes(s.binding)) out.push(s.binding);
    return out;
  }

  /** Canonical shortcut text a command is reachable by (for tooltips), or null. */
  shortcutFor(command: string, args?: Record<string, unknown> | null): string | null {
    const argKey = JSON.stringify(args ?? null);
    for (const table of this.tables.values()) for (const [text, b] of table) {
      if (b.command === command && (args === undefined || JSON.stringify(b.args ?? null) === argKey)) return text;
    }
    return null;
  }

  /** Route one keydown. Returns whether it was claimed (the caller prevents default when it was). */
  keydown(e: KeyLike): RouteResult {
    const chord = chordFromEvent(e);
    if (!chord) return {handled: false};
    const text = chordText(chord, this.platform);
    // A bare Alt press arms keytips; any other key in between disarms them.
    if (isBareModifier(chord)) { this.altArmed = chord.key === 'Alt' && !e.repeat; return {handled: false}; }
    this.altArmed = false;
    return this.route(chord, text);
  }

  /** Alt released without another key in between toggles keytips (F10 does it on keydown). */
  keyup(e: KeyLike): RouteResult {
    if ((NAMED[e.key] ?? e.key) === 'Alt' && this.altArmed) {
      this.altArmed = false;
      if (this.opts.keytips) { this.opts.keytips.toggle(); return {handled: true, scope: 'keytips'}; }
    }
    this.altArmed = false;
    return {handled: false};
  }

  /** `ui.key {keys}`: route a chord or a sequence ('Mod+B', 'Alt, H, F, F', 'Escape') with no DOM event. */
  feed(keys: string): RouteResult[] {
    const parsed = parseShortcut(keys)[0];
    if (!parsed || !parsed.steps) throw new Error(`Cannot parse keys "${keys}"`);
    const results: RouteResult[] = [];
    for (const step of parsed.steps) {
      const chord = {...step};
      if (chord.mod) { chord.mod = false; if (this.platform === 'mac') chord.meta = true; else chord.ctrl = true; }
      if (isBareModifier(chord)) {
        if (chord.key === 'Alt' && this.opts.keytips) { this.opts.keytips.toggle(); results.push({handled: true, scope: 'keytips'}); }
        else results.push({handled: false});
        continue;
      }
      results.push(this.route(chord, chordText(chord, this.platform)));
    }
    return results;
  }

  private route(chord: Chord, text: string): RouteResult {
    // 1. Dialog scope.
    const d = this.opts.dialog?.(chord, text) ?? false;
    if (d === true) return {handled: true, scope: 'dialog'};
    if (d === 'pass') return {handled: false, scope: 'dialog'};
    // 2. Keytips.
    if (this.opts.keytips?.active()) { this.opts.keytips.key(chord, text); return {handled: true, scope: 'keytips'}; }
    if (text === 'F10' && this.opts.keytips) { this.opts.keytips.toggle(); return {handled: true, scope: 'keytips'}; }
    // Key sequences in progress.
    const now = (this.opts.now ?? Date.now)();
    if (this.prefix.length && now - this.prefixAt > (this.opts.sequenceMs ?? 2000)) this.prefix = [];
    const seq = [...this.prefix, text];
    const candidates = this.sequences.filter(s => seq.every((t, i) => s.steps[i] === t) && this.scopeOk(s.binding.scope));
    const done = candidates.find(s => s.steps.length === seq.length);
    if (done) { this.prefix = []; this.opts.run(done.binding); return {handled: true, binding: done.binding, scope: 'sequence'}; }
    if (candidates.length && !this.lookup(text)) { this.prefix = seq; this.prefixAt = now; return {handled: true, scope: 'sequence'}; }
    this.prefix = [];
    // 3./4. Surface scope, then app scope.
    const hit = this.lookup(text);
    if (!hit) return {handled: false};
    this.opts.run(hit.binding);
    return {handled: true, binding: hit.binding, scope: hit.scope};
  }

  private scopeOk(scope: Scope) { return scope === 'app' || !!this.opts.scopeActive?.(scope); }

  /** Wire to a window: capture-phase keydown/keyup; claimed keys never reach the page. */
  attach(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, shouldIgnore?: (e: KeyboardEvent) => boolean): () => void {
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || shouldIgnore?.(e)) return;
      const r = this.keydown(e);
      if (r.handled) { e.preventDefault(); e.stopPropagation(); }
    };
    const up = (e: KeyboardEvent) => {
      const r = this.keyup(e);
      if (r.handled) { e.preventDefault(); e.stopPropagation(); }
    };
    target.addEventListener('keydown', down as EventListener, true);
    target.addEventListener('keyup', up as EventListener, true);
    return () => { target.removeEventListener('keydown', down as EventListener, true); target.removeEventListener('keyup', up as EventListener, true); };
  }
}

/** Keys a text field keeps for itself even when a binding exists (typing, caret movement, clipboard). */
export function fieldOwns(text: string, multiline: boolean): boolean {
  if (/^(Shift\+)?[A-Z0-9]$/.test(text) || text === 'Space' || text === 'Shift+Space') return true;
  if (/^(Shift\+)?(Left|Right|Home|End|Backspace|Delete)$/.test(text)) return true;
  if (/^(Ctrl|Meta)\+(Shift\+)?(A|C|V|X|Z|Y|Left|Right|Backspace|Delete)$/.test(text)) return true;
  if (multiline && /^(Shift\+)?(Up|Down|Enter|PageUp|PageDown)$/.test(text)) return true;
  return false;
}
