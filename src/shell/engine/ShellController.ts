// The shell's state and behaviour, independent of React (docs/architecture.md sections 8–11, 15.3).
//
// Everything the person can do in the shell (switch a tab, press a control, open, fill and submit
// a dialog, show a pane, press a key) is a method here, and the React components only call these
// methods and render the state. RendererBridge calls the same methods for `ui.*` requests, so a
// window driven over the bridge and one driven by a person go through identical code.

import type {Session, ExecResult, SessionEvent} from '../../../core/kernel/session.mjs';
import type {DialogModel} from '../../../core/kernel/dialog.mjs';
import type {CommandFamily, RegisteredCommand, ControlState} from '../../../core/kernel/command.mjs';
import {requiredKeys} from '../../../core/kernel/schema.mjs';
import {CommandError, toCommandError} from '../../../core/kernel/errors.mjs';
import {dialogStem} from '../../../core/kernel/dialog.mjs';
import {savePrompt} from '../../../core/common/lib/save-prompt.mjs';
import type {SpecControl, SpecDialog, SpecField, SpecPane, UiManifest, LazyModule, Args, SpecBackstageNode, SpecMenuEntry} from '../../generated/spec-types';
import {SHOW_PENDING, platform} from '../env';
import {buildShellModel, isControl, concreteArgs, fillArgs, displayLabel, type ShellModel, type RibbonTab, type RibbonGroup} from '../model';
import {KeyRouter, chordText, fieldOwns, type Binding} from '../keys/KeyRouter';
import {assignKeytips, matchKeytip, qatKeytips, KEYTIPS_OFF, type KeytipState} from '../keys/keytipTable';
import {
  createDialogState, setValue as setDialogValueState, validateState, submission, tabOf, snapshot, builtinSpec, changedFields, allFields,
  type DialogState, type Values,
} from '../dialogs/dialogState';
import type {Level} from '../ribbon/fit';
import {parseShortcut, type Chord} from '../../../core/kernel/command.mjs';

export interface UiIndex {
  manifest: UiManifest;
  uiCommands: CommandFamily[];
  dialogs: Record<string, LazyModule>;
  panes: Record<string, LazyModule>;
  backstage: Record<string, LazyModule>;
  extensions: Record<string, LazyModule>;
}

/** What an app's surface registers so the shell can hand focus back and paint gallery previews. */
export interface SurfaceHandle {
  focus?(): void;
  /** Paint a dry-run result (gallery live preview); `clearPreview` removes it. */
  preview?(result: ExecResult): void;
  clearPreview?(): void;
  /** View-derived contextual flags (a picture is selected, the caret is in a table...). */
  contextFlags?(): Record<string, boolean>;
  /** PNG data URL of a page, slide or range (document.render). */
  render?(target: unknown, scale?: number): Promise<string | null>;
  // Bridge input (docs/bridge-protocol.md §3.2: `ui.pointer`, `ui.type`, `ui.key`). The surface runs
  // the same code its own pointer and keyboard handlers run; no DOM or OS event is ever made.
  /** A pointer gesture in the surface's own coordinates (each app documents its params). */
  pointer?(params: Record<string, unknown>): unknown;
  /** Text typed at the surface's caret, as the keyboard types it. */
  type?(text: string): unknown;
  /**
   * One key the surface handles itself (navigation, editing keys, Escape, F2...): `key` is the DOM
   * key name ('ArrowLeft', 'Enter', 'F2', 'a'), `modifiers` lower-case ('shift', 'ctrl', 'alt',
   * 'meta'). Answers `{handled: false}` when the key is the shortcut table's.
   */
  keys?(key: string, modifiers: string[]): unknown;
  /** deckcraft's `Session::key` shape: the key and `{shift, ctrl, alt, meta, cmd}`. Used when `keys` is absent. */
  key?(key: string, mods: Record<string, boolean>): unknown;
  /** Values for status-bar items that have no command (`{'status.page': {page: 2, pages: 9}}`); re-read on every shell tick. */
  status?(): Record<string, unknown>;
  /**
   * A right-click at window coordinates: the surface selects what is under the pointer when it is
   * outside the selection (Office does) and answers the spec's context-menu target ('cell',
   * 'rowHeader', 'shape'...), or null to use the app's default.
   */
  contextMenu?(clientX: number, clientY: number): Promise<string | null> | string | null;
  /**
   * Called before a right-click menu opens for `target` without a pointer (the bridge's ui.contextMenu, a key): the surface looks up
   * what the menu's dynamic entries need (a misspelt word's suggestions) so they show at once.
   */
  contextPrepare?(target: string): Promise<void> | void;
  /** The zoom the person sees in percent, when it differs from `view.zoom` (a fit mode). */
  zoom?(): number | null | undefined;
}

export type RibbonMode = 'always' | 'tabs' | 'autohide';
export interface PaneState { id: string; open: boolean; dock: 'left' | 'right' | 'float'; width: number }
export interface Toast { id: number; text: string; tone: 'info' | 'error' }

export interface ShellState {
  tab: string;
  previousTab: string;
  backstage: {open: boolean; page: string | null};
  ribbon: {mode: RibbonMode; peek: boolean};
  dialogs: DialogState[];
  panes: PaneState[];
  keytips: KeytipState;
  flags: Record<string, boolean>;
  menu: string | null;
  /** A submenu of the open menu the bridge asked open (ui.menu on a nested control): that control's flyout shows. */
  menuSub?: string | null;
  /** The open right-click menu: its spec target and where it opened (window px). */
  contextMenu: {target: string; x: number; y: number} | null;
  /** The collapsed group whose drop-down is open (it stays open while its controls are used). */
  groupMenu: string | null;
  toast: Toast | null;
  /**
   * Fit levels the ribbon drew per group key (ui.inspect reports collapsed groups). An app's own
   * chrome (manifest.chrome) reports every group it draws here, its rails and bars included, so
   * ui.inspect lists their controls as well as the active tab's.
   */
  levels: Record<string, Level>;
  /**
   * The group a chrome shows as a panel of its own (Acrobat's tool panel: All tools ▸ Add comments),
   * by group key ('all-tools/comment'), or null. The ribbon does not use it.
   */
  panel: string | null;
  busy: string | null;
}

const SAVE_PROMPTS = ['dialog.saveChanges', 'prompt.save-changes', 'dialog.close'];
const MORE_COLORS = 'shell.moreColors';
const builtinDialogs: Record<string, SpecDialog> = {
  [MORE_COLORS]: builtinSpec(MORE_COLORS, 'Colors', [
    {id: 'color', label: 'Color', kind: 'colorPicker', options: []},
  ]),
  'shell.saveChanges': {...builtinSpec('shell.saveChanges', 'Save Changes?', [
    {id: 'message', label: '', kind: 'message', options: []},
  ], [
    {id: 'save', label: 'Save', role: 'ok', command: null},
    {id: 'dont-save', label: "Don't Save", role: 'other', command: null},
    {id: 'cancel', label: 'Cancel', role: 'cancel', command: null},
  ]), command: 'file.close'},
};
const builtinModels: Record<string, DialogModel> = {'shell.saveChanges': savePrompt('shell.saveChanges', 'Save Changes?') as unknown as DialogModel};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** PDF's spec also lists its title-bar chrome, right rail and floating toolbar as "tabs": only real tabs go in the tab strip. */
const isRibbonSurface = (t: RibbonTab) => !t.surface || t.surface === 'modeTab' || t.surface === 'ribbon';

export interface ControllerOptions {
  kind: ShellModel['app'];
  session: Session;
  docId: string;
  model: ShellModel | null;
  ui: UiIndex;
  coreDialogs: Record<string, DialogModel>;
  onClose?: () => void;
  onBack?: () => void;
  prefsKey?: string;
}

export class ShellController {
  readonly kind: ShellModel['app'];
  readonly session: Session;
  readonly docId: string;
  model: ShellModel | null;
  readonly ui: UiIndex;
  readonly coreDialogs: Record<string, DialogModel>;
  readonly router: KeyRouter;
  view: SurfaceHandle | null = null;
  onClose?: () => void;
  onBack?: () => void;
  /** Last color each color control applied (the split's main part re-applies it). */
  readonly lastColors = new Map<string, string>();
  private state: ShellState;
  private listeners = new Set<() => void>();
  private offSession: () => void;
  private toastSeq = 0;
  private previewing = false;
  /** Origin and approval for the next dialog command (a bridge submit runs through the approval gate). */
  private execOpts: {origin: 'dialog' | 'bridge'; approval?: {nonce: string}; rethrow: boolean} = {origin: 'dialog', rethrow: false};
  private ribbonVersion = 0;
  /** Contextual flags a development build forced on to review a tab (setTab). */
  private forced = new Set<string>();

  constructor(o: ControllerOptions) {
    this.kind = o.kind;
    this.session = o.session;
    this.docId = o.docId;
    this.model = o.model;
    this.ui = o.ui;
    this.coreDialogs = o.coreDialogs;
    this.onClose = o.onClose;
    this.onBack = o.onBack;
    const first = this.model?.tabs.find(t => !t.contextual)?.id ?? 'home';
    const saved = readPrefs(`arkemis.shell.${o.kind}`);
    this.state = {
      tab: first, previousTab: first, backstage: {open: false, page: null},
      ribbon: {mode: (saved.ribbonMode as RibbonMode) ?? 'always', peek: false},
      dialogs: [], panes: [], keytips: KEYTIPS_OFF, flags: {}, menu: null, contextMenu: null, groupMenu: null, toast: null, levels: {}, panel: null, busy: null,
    };
    this.router = new KeyRouter({
      platform: platform(),
      bindings: this.bindings(),
      scopeActive: scope => scope === 'app' || !!this.state.flags[scope],
      dialog: (chord, text) => this.dialogKey(chord, text),
      keytips: {active: () => this.state.keytips.phase !== 'off', key: (c, t) => this.keytipKey(c, t), toggle: () => this.toggleKeytips()},
      run: b => { void this.runBinding(b); },
    });
    this.offSession = this.session.subscribe(e => this.onSessionEvent(e));
    this.refreshFlags(true);
  }

  dispose() { this.offSession(); this.listeners.clear(); }

  // -------------------------------------------------------------------------------------------
  // Store

  getState = (): ShellState => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  /** Re-render subscribers (document status changed outside a shell action). */
  touch() { this.set({}); }
  private set(patch: Partial<ShellState>) {
    this.state = {...this.state, ...patch};
    for (const fn of [...this.listeners]) fn();
  }

  // -------------------------------------------------------------------------------------------
  // Registry, pending rule (section 8.7)

  command(id: string | null | undefined): RegisteredCommand | null { return id ? this.session.registry.get(id) : null; }
  hasCommand(id: string | null | undefined): boolean { return !!id && this.session.registry.has(id); }
  dialogSpec(id: string): SpecDialog | null { return this.model?.spec.dialogs[id] ?? builtinDialogs[id] ?? null; }
  dialogModel(id: string): DialogModel | null { return this.coreDialogs[id] ?? builtinModels[id] ?? null; }
  dialogOverride(id: string): LazyModule | null { return this.ui.dialogs[id] ?? this.ui.dialogs[dialogStem(id)] ?? null; }
  /** A dialog works when it has a model, an override, or a registered submit command (or is built in). */
  dialogImplemented(id: string): boolean {
    if (builtinDialogs[id]) return true;
    if (this.dialogModel(id) || this.dialogOverride(id)) return true;
    const spec = this.dialogSpec(id);
    return !!spec?.command && this.hasCommand(spec.command) && !spec.tabs.some(t => t.fields.length);
  }
  isImplemented(c: SpecControl): boolean {
    if (c.command) return this.hasCommand(c.command);
    if (c.dialog) return this.dialogImplemented(c.dialog);
    if (c.launcher) return true;
    return (c.items ?? []).some(k => isControl(k) && this.isImplemented(k));
  }
  /** Rendered at all: implemented, or pending in a development build. */
  shows(c: SpecControl): boolean { return SHOW_PENDING || this.isImplemented(c); }
  groupShows(g: RibbonGroup): boolean { return g.controls.some(c => isControl(c) && this.shows(c)); }

  /** Control state for a control (memoized per session tick by the kernel). */
  controlState(c: SpecControl): ControlState & {pending: boolean} {
    if (!this.isImplemented(c)) return {enabled: false, reason: `Not translated yet: ${c.command ?? c.dialog ?? c.id}`, pending: true};
    if (!c.command) return {enabled: true, pending: false};
    const st = this.session.state(this.docId, c.command, concreteArgs(c.args));
    // The Arkemis control is a toggle for its pane.
    return {...st, pending: false};
  }

  // -------------------------------------------------------------------------------------------
  // Tabs, contextual tabs (section 8.6), ribbon display

  /** Tabs in order: normal tabs, then contextual tabs whose flag holds. Customized order applies. */
  visibleTabs(): RibbonTab[] {
    if (!this.model) return [];
    const tabs = this.customizedTabs();
    const shown = tabs.filter(t => (t.contextual ? !!this.state.flags[t.contextFor ?? t.id] : isRibbonSurface(t))
      && t.groups.some(g => this.groupShows(g)));
    // A contextual tab the overlay places right after File (Word's Outlining) comes first.
    const first = (t: RibbonTab) => ((t as any).position === 'afterFile' ? 0 : 1);
    return shown.map((t, i) => [t, i] as const).sort((a, b) => first(a[0]) - first(b[0]) || a[1] - b[1]).map(([t]) => t);
  }
  contextualTabs(): RibbonTab[] { return this.visibleTabs().filter(t => t.contextual); }

  private customizedTabs(): RibbonTab[] {
    const model = this.model!;
    const layout = (this.session.prefs as any)?.ribbon?.tabs;
    if (!Array.isArray(layout) || !layout.length) return model.tabs;
    const byLabel = new Map(model.tabs.map(t => [t.label.toLowerCase(), t]));
    const out: RibbonTab[] = [];
    for (const entry of layout) {
      if (!entry || typeof entry.name !== 'string' || entry.hidden) continue;
      const base = byLabel.get(entry.name.toLowerCase());
      const custom = (Array.isArray(entry.groups) ? entry.groups : []).map((g: any, i: number): RibbonGroup => {
        const id = `custom-${i}-${norm(String(g.name))}`;
        const controls = (Array.isArray(g.commands) ? g.commands : []).map((cmd: string) => this.controlForCommand(cmd, `${base?.id ?? 'custom'}.${id}`));
        return {id, key: `${base?.id ?? norm(entry.name)}/${id}`, tab: base?.id ?? norm(entry.name), label: String(g.name), launcher: null, keytip: null,
          collapseOrder: null, collapsedIcon: null, widths: {}, controls, layout: controls.reduce((acc: any[], c: SpecControl, j: number) => {
            if (j % 3 === 0) acc.push({stack: []});
            acc[acc.length - 1].stack.push(c.id);
            return acc;
          }, [])};
      });
      if (base) out.push({...base, groups: [...base.groups, ...custom]});
      else out.push({id: norm(entry.name) || `custom-${out.length}`, label: entry.name, contextual: false, contextFor: null, contextNote: null, keytip: null,
        surface: null, mode: null, source: null, sourceRef: null, layoutSource: 'custom', groups: custom});
    }
    for (const t of model.tabs) if (t.contextual) out.push(t);
    return out;
  }

  /** A control for a command id (QAT and custom groups): the spec's first control for it, or a plain button. */
  controlForCommand(command: string, prefix = 'qat'): SpecControl {
    for (const c of this.model?.controls.values() ?? []) if (c.command === command && !c.args && c.type !== 'combo') {
      const registered = this.model!.controls.get(`${prefix}.${command}`);
      if (registered) return registered;
      const synthetic: SpecControl = {...c, id: `${prefix}.${command}`, items: undefined, type: c.type === 'split' || c.type === 'menu' ? 'button' : c.type};
      this.model!.controls.set(synthetic.id, synthetic);
      return synthetic;
    }
    const label = this.command(command)?.label ?? command;
    const synthetic: SpecControl = {id: `${prefix}.${command}`, label, kind: 'button', type: 'button', command, args: null, shortcut: null, dialog: null,
      icon: null, source: null, sourceRef: null};
    this.model?.controls.set(synthetic.id, synthetic);
    return synthetic;
  }

  /** Quick Access Toolbar: the person's customization (prefs.ribbon.qat) or the spec's defaults. */
  qat(): SpecControl[] {
    const custom = (this.session.prefs as any)?.ribbon?.qat;
    const list = Array.isArray(custom) ? custom.filter((x: unknown) => typeof x === 'string').map((cmd: string) => this.controlForCommand(cmd))
      : (this.model?.spec.qat ?? []).filter(isControl);
    return list.filter(c => this.shows(c));
  }

  setTab(id: string) {
    // 'tab/group' (a group key): the tab, with that group shown as its own panel (an app chrome's tool panel).
    const slash = String(id).indexOf('/');
    if (slash > 0) {
      this.setTab(id.slice(0, slash));
      const name = id.slice(slash + 1).toLowerCase();
      const g = this.activeTab()?.groups.find(x => x.id.toLowerCase() === name || x.label.toLowerCase() === name);
      if (!g || !this.groupShows(g)) throw new CommandError('not_found', `No visible group ${id}`, {groups: (this.activeTab()?.groups ?? []).filter(x => this.groupShows(x)).map(x => x.key)});
      this.setPanel(g.key);
      return;
    }
    const match = (t: RibbonTab) => t.id === id || t.label.toLowerCase() === String(id).toLowerCase();
    // Development builds: choosing a contextual tab whose context does not hold yet forces it, so
    // every tab's layout can be reviewed before the app's foundation emits the flag.
    const target = this.model?.tabs.find(match);
    if (SHOW_PENDING && target && this.forced.size) {
      // Leaving a forced context (or forcing another) drops the previous one: one review at a time.
      const flags = {...this.state.flags};
      for (const f of this.forced) if (f !== (target.contextFor ?? target.id)) delete flags[f];
      this.forced.clear();
      this.set({flags});
    }
    const hidden = SHOW_PENDING && target?.contextual && !this.state.flags[target.contextFor ?? target.id] ? target : null;
    if (hidden) { this.forced.add(hidden.contextFor ?? hidden.id); this.set({flags: {...this.state.flags, [hidden.contextFor ?? hidden.id]: true}}); }
    const tabs = this.visibleTabs();
    const tab = tabs.find(match);
    if (!tab) throw new CommandError('not_found', `No visible tab ${id}`, {tabs: tabs.map(t => t.id)});
    const prev = this.state.tab;
    const previousTab = tab.contextual ? (this.tabIsContextual(prev) ? this.state.previousTab : prev) : tab.id;
    this.set({tab: tab.id, previousTab, backstage: {open: false, page: null}, menu: null, groupMenu: null, panel: null, ribbon: {...this.state.ribbon, peek: this.state.ribbon.mode !== 'always'}});
  }
  /** Show a group as a panel of its own (`tab/group` key), or none (an app chrome's tool panel; ui.tab 'all-tools/comment'). */
  setPanel(key: string | null) {
    if (key !== null && !this.model?.tabs.some(t => t.groups.some(g => g.key === key))) throw new CommandError('not_found', `No group ${key}`);
    if (this.state.panel !== key) this.set({panel: key, menu: null});
  }
  private tabIsContextual(id: string) { return !!this.model?.tabs.find(t => t.id === id)?.contextual; }
  /** The tab shown: the chosen one while it is visible, else the first normal tab. */
  activeTab(): RibbonTab | null {
    const tabs = this.visibleTabs();
    return tabs.find(t => t.id === this.state.tab) ?? tabs.find(t => t.id === this.state.previousTab) ?? tabs[0] ?? null;
  }
  setRibbonMode(mode: RibbonMode) {
    this.set({ribbon: {mode, peek: false}});
    writePrefs(this.prefsKey(), {ribbonMode: mode});
  }
  setPeek(peek: boolean) { if (this.state.ribbon.peek !== peek) this.set({ribbon: {...this.state.ribbon, peek}}); }
  toggleRibbonCollapsed() { this.setRibbonMode(this.state.ribbon.mode === 'always' ? 'tabs' : 'always'); }
  private prefsKey() { return `arkemis.shell.${this.kind}`; }

  openBackstage(page?: string | null) {
    const pages = (this.model?.backstage ?? []).filter(n => n.kind === 'page');
    const first = pages.find(p => this.backstageShows(p)) ?? pages[0];
    this.set({backstage: {open: true, page: page ?? this.state.backstage.page ?? first?.id ?? null}, menu: null, keytips: KEYTIPS_OFF});
  }
  closeBackstage() { if (this.state.backstage.open) { this.set({backstage: {open: false, page: null}}); this.focusSurface(); } }
  backstageShows(n: SpecBackstageNode): boolean { return SHOW_PENDING || this.backstageImplemented(n); }
  /** A backstage page or action works: its command or dialog exists, the app or the shell draws the page, or one of its actions works. */
  backstageImplemented(n: SpecBackstageNode): boolean {
    if (n.kind === 'page' && builtinPageKey(n)) return true;
    if (n.command) return this.hasCommand(n.command);
    if (n.dialog) return this.dialogImplemented(n.dialog);
    if (this.ui.backstage[n.id] || this.ui.backstage[n.id.replace(/^file\./, '')]) return true;
    return (n.children ?? []).some(k => this.backstageImplemented(k));
  }

  setMenu(id: string | null, sub: string | null = null) { if (this.state.menu !== id || (this.state.menuSub ?? null) !== sub) this.set({menu: id, menuSub: sub}); }
  setGroupMenu(key: string | null) { if (this.state.groupMenu !== key) this.set({groupMenu: key, menu: null}); }
  setLevels(levels: Record<string, Level>) {
    const same = Object.keys(levels).length === Object.keys(this.state.levels).length && Object.entries(levels).every(([k, v]) => this.state.levels[k] === v);
    if (!same) this.set({levels});
  }

  // -------------------------------------------------------------------------------------------
  // Contextual flags

  private onSessionEvent(e: SessionEvent) {
    // A view change can bring a contextual tab too (Word's Outlining and Immersive Reader tabs).
    if (e.type === 'doc.changed' || e.type === 'selection.changed' || e.type === 'document.opened' || e.type === 'view.changed') this.refreshFlags(false);
    if (e.type === 'prefs.changed') { this.ribbonVersion++; this.router.setBindings(this.bindings()); this.set({}); writePrefs(`arkemis.prefs.${this.kind}`, e.prefs); }
    if (e.type === 'document.closed' && e.doc === this.docId) this.onClose?.();
  }
  /** Re-read contextual flags; a contextual tab takes focus only when the selection enters its context. */
  refreshFlags(initial: boolean) {
    let flags: Record<string, boolean> = {};
    try { flags = {...this.session.contextFlags(this.docId)}; } catch { /* no foundation yet */ }
    try { Object.assign(flags, this.view?.contextFlags?.() ?? {}); } catch { /* surface not ready */ }
    for (const f of this.forced) flags[f] = true;
    const before = this.state.flags;
    const same = Object.keys(flags).length === Object.keys(before).length && Object.entries(flags).every(([k, v]) => !!before[k] === !!v);
    if (same && !initial) return;
    const patch: Partial<ShellState> = {flags};
    if (!initial && this.model && !this.state.backstage.open) {
      const entered = this.model.tabs.find(t => t.contextual && flags[t.contextFor ?? t.id] && !before[t.contextFor ?? t.id]);
      const current = this.model.tabs.find(t => t.id === this.state.tab);
      if (entered) { patch.tab = entered.id; patch.previousTab = current?.contextual ? this.state.previousTab : this.state.tab; }
      else if (current?.contextual && !flags[current.contextFor ?? current.id]) patch.tab = this.state.previousTab;
    }
    this.set(patch);
  }

  // -------------------------------------------------------------------------------------------
  // Activation (section 8.3)

  /** Press a ribbon, QAT or backstage control through its normal handler (`ui.activate`). */
  async activate(controlId: string, opts: {value?: unknown; origin?: 'ui' | 'bridge' | 'shortcut'; approval?: {nonce: string}} = {}): Promise<ExecResult | null> {
    const origin = opts.origin ?? 'ui';
    const c = this.model?.controls.get(controlId);
    if (!c) {
      const node = this.findBackstage(controlId);
      if (node) return this.activateBackstage(node, origin);
      throw new CommandError('not_found', `No control ${controlId}`);
    }
    if (!this.isImplemented(c)) throw new CommandError('unavailable', `Not translated yet: ${c.command ?? c.dialog ?? c.id}`, {control: c.id});
    const st = this.controlState(c);
    if (!st.enabled) throw new CommandError('disabled', st.reason ?? `${displayLabel(c)} is not available now`, {control: c.id});
    this.set({menu: null, contextMenu: null});
    let args: Args | null = c.args;
    if (opts.value !== undefined) args = fillArgs(c.args, opts.value, c.type === 'color' || c.type === 'palette' ? 'color' : 'value');
    else if ((c.type === 'color' || c.type === 'palette') && this.lastColors.has(c.id)) args = fillArgs(c.args, this.lastColors.get(c.id), 'color');
    if (opts.value !== undefined && (c.type === 'color' || c.type === 'palette')) this.lastColors.set(c.id, String(opts.value));
    if (c.command) return this.run(c.command, args, {origin: origin === 'bridge' ? 'bridge-ui' : origin, dialog: c.dialog, control: c, approval: opts.approval});
    if (c.dialog) { this.openDialog(c.dialog, {args: concreteArgs(c.args), origin}); return null; }
    if (c.items?.length) { this.setMenu(c.id); return null; }
    return null;
  }

  findBackstage(id: string): SpecBackstageNode | null {
    const walk = (list: SpecBackstageNode[]): SpecBackstageNode | null => {
      for (const n of list) { if (n.id === id) return n; const k = walk(n.children ?? []); if (k) return k; }
      return null;
    };
    return walk(this.model?.backstage ?? []);
  }
  async activateBackstage(n: SpecBackstageNode, origin: 'ui' | 'bridge' | 'shortcut' = 'ui'): Promise<ExecResult | null> {
    if (n.id === 'file.back' || /^back\b/i.test(n.label)) { this.closeBackstage(); return null; }
    // A page the app or the shell draws opens as that page, before the node's own dialog or command
    // (Grid's Save a Copy is a page of places, its dialog.saveCopy is what the page's Browse runs).
    if (n.kind === 'page' && (this.ui.backstage[n.id] || this.ui.backstage[n.id.replace(/^file\./, '')] || builtinPageKey(n))) { this.openBackstage(n.id); return null; }
    if (n.kind === 'page' && !n.command) { this.openBackstage(n.id); return null; }
    if (n.dialog) { this.openDialog(n.dialog, {args: concreteArgs(n.args), origin}); return null; }
    if (n.command) {
      const r = await this.run(n.command, n.args, {origin: origin === 'bridge' ? 'bridge-ui' : origin});
      if (n.command !== 'file.save') this.closeBackstage();
      return r;
    }
    if (n.kind === 'page') this.openBackstage(n.id);
    return null;
  }

  /**
   * Run a command the way the UI does: a control that names a dialog opens it when its args lack
   * required params; closing a modified document asks first; errors become a toast. `bridge-ui`
   * is a bridge `ui.activate`: the same handling, but errors are thrown back to the caller.
   */
  async run(command: string, args: Args | null | undefined, opts: {origin?: 'ui' | 'shortcut' | 'bridge-ui' | 'dialog'; dialog?: string | null; control?: SpecControl; approval?: {nonce: string}} = {}): Promise<ExecResult | null> {
    const origin = opts.origin ?? 'ui';
    const throwBack = origin === 'bridge-ui';
    try {
      const cmd = this.command(command);
      const dialogId = opts.dialog ?? cmd?.dialog ?? null;
      const params = concreteArgs(args);
      if (UI_COMMANDS[command]) return UI_COMMANDS[command](this, params);
      if (!cmd) {
        if (dialogId && this.dialogImplemented(dialogId)) { this.openDialog(dialogId, {args: params}); return null; }
        throw new CommandError('not_found', `Not translated yet: ${command}`);
      }
      const missing = requiredKeys(cmd.params).some(k => !(k in params));
      const noArgs = !args || !Object.keys(args).length;
      if (dialogId && this.dialogImplemented(dialogId) && (missing || noArgs) && origin !== 'dialog') {
        this.openDialog(dialogId, {args: params, origin: throwBack ? 'bridge' : 'ui'});
        return null;
      }
      if (command === 'file.close' && !params.save && !params.force && this.isDirty()) { this.promptSave(); return null; }
      const busy = setTimeout(() => this.set({busy: cmd.label}), 150);
      let result: ExecResult;
      try {
        result = await this.session.execute(this.docId, command, params, {origin: origin === 'bridge-ui' ? 'bridge' : origin, approval: opts.approval});
      } finally {
        clearTimeout(busy);
        if (this.state.busy) this.set({busy: null});
      }
      if (cmd.needs !== 'view' && !command.startsWith('ui.') && origin !== 'dialog') this.focusSurface();
      return result;
    } catch (e) {
      const err = toCommandError(e);
      if (throwBack) throw err;
      this.notify(err.message, 'error');
      return null;
    }
  }

  private runBinding(b: Binding) {
    if (b.command) return this.run(b.command, b.args ?? null, {origin: 'shortcut', dialog: b.dialog});
    if (b.dialog) { try { this.openDialog(b.dialog, {args: b.args ?? null}); } catch (e) { this.notify(toCommandError(e).message, 'error'); } }
    return null;
  }

  isDirty() { try { return !!this.session.get(this.docId).dirty; } catch { return false; } }
  focusSurface() { try { this.view?.focus?.(); } catch { /* the surface may be gone */ } }

  /** The spec's right-click menu for a target ("cell", "slide-thumbnail", "page (no object)"...), matched loosely. */
  contextMenuSpec(target: string): {target: string; items: SpecMenuEntry[]} | null {
    const menus = this.model?.contextMenus ?? [];
    const key = norm(target);
    return menus.find(m => m.target === target) ?? menus.find(m => norm(m.target) === key)
      ?? menus.find(m => norm(m.target.replace(/\s*\(.*$/, '')) === key) ?? null;
  }
  /** Entries a target's menu shows now (implemented ones; pending ones only in a development build). */
  contextEntries(target: string): SpecMenuEntry[] {
    const m = this.contextMenuSpec(target);
    if (!m) return [];
    // A command whose state says `hidden` does not apply here (Excel's Show Details only on a PivotTable value cell); the menu leaves it out too.
    return m.items.filter(e => !isControl(e) || (this.shows(e) && !(this.controlState(e) as {hidden?: boolean}).hidden));
  }
  /** Open the right-click menu for `target` at window coordinates; false when it has nothing to show. */
  openContextMenu(target: string, x: number, y: number): boolean {
    const m = this.contextMenuSpec(target);
    if (!m || !this.contextEntries(m.target).some(isControl)) { this.closeContextMenu(); return false; }
    this.set({contextMenu: {target: m.target, x, y}, menu: null, groupMenu: null, keytips: KEYTIPS_OFF});
    return true;
  }
  closeContextMenu() { if (this.state.contextMenu) this.set({contextMenu: null}); }

  notify(text: string, tone: Toast['tone'] = 'info') { this.set({toast: {id: ++this.toastSeq, text, tone}}); }
  dismissToast(id: number) { if (this.state.toast?.id === id) this.set({toast: null}); }

  /** Gallery live preview: run the command as a dry run and let the surface paint it. */
  async preview(command: string | null, args: Args | null) {
    if (!command || !this.hasCommand(command) || !this.view?.preview) return;
    try {
      const r = await this.session.execute(this.docId, command, concreteArgs(args), {origin: 'ui', dryRun: true});
      this.previewing = true;
      this.view.preview(r);
    } catch { /* previews never surface errors */ }
  }
  endPreview() { if (this.previewing) { this.previewing = false; try { this.view?.clearPreview?.(); } catch { /* ignore */ } } }

  // -------------------------------------------------------------------------------------------
  // Dialogs (section 9)

  promptSave() {
    const id = SAVE_PROMPTS.find(d => this.dialogSpec(d) && this.dialogModel(d)) ?? 'shell.saveChanges';
    return this.openDialog(id, {});
  }

  /** Open a dialog (on top of the stack); returns its key. */
  openDialog(id: string, opts: {args?: Args | null; parent?: string | null; target?: DialogState['target']; init?: Values; origin?: DialogState['origin']} = {}): string {
    const spec = this.dialogSpec(id);
    if (!spec) throw new CommandError('not_found', `No dialog ${id}`);
    const model = this.dialogModel(id);
    const pending = !this.dialogImplemented(id) && !(spec.command && this.hasCommand(spec.command));
    if (pending && !SHOW_PENDING) throw new CommandError('unavailable', `Not translated yet: ${id}`);
    let init: Values | null = opts.init ?? null;
    if (model) {
      try { init = {...model.init(this.session.readContext(this.docId) as any, opts.args ?? null), ...(opts.init ?? {})}; }
      catch (e) { if (!pending) throw toCommandError(e); }
    }
    const st = createDialogState(spec, {init, pending, parent: opts.parent ?? null, target: opts.target ?? null, args: opts.args ?? null, origin: opts.origin ?? 'ui'});
    // An opener may name the page to show (Office: Page Borders opens Borders and Shading on its
    // Page Border tab, Custom Margins… opens Page Setup on Margins): args `{tab: name | index}`.
    const tab = opts.args?.tab;
    if (typeof tab === 'number' || typeof tab === 'string') {
      const i = typeof tab === 'number' ? tab : spec.tabs.findIndex(t => norm(t.name) === norm(tab));
      if (i >= 0 && i < spec.tabs.length) st.tab = i;
    }
    this.set({dialogs: [...this.state.dialogs, st], menu: null, keytips: KEYTIPS_OFF});
    if (spec.presentation === 'backstage') this.set({backstage: {open: true, page: `dialog:${st.key}`}});
    return st.key;
  }

  dialog(key?: string | null): DialogState | null {
    const list = this.state.dialogs;
    if (!key) return list[list.length - 1] ?? null;
    return list.find(d => d.key === key) ?? [...list].reverse().find(d => d.id === key) ?? null;
  }
  private need(key?: string | null): DialogState {
    const d = this.dialog(key);
    if (!d) throw new CommandError('not_found', key ? `Dialog ${key} is not open` : 'No dialog is open');
    return d;
  }
  private replace(next: DialogState) { this.set({dialogs: this.state.dialogs.map(d => (d.key === next.key ? next : d))}); }

  setDialogValue(key: string | null, field: string, value: unknown) {
    const d = this.need(key);
    this.replace(setDialogValueState(d, field, value, this.dialogModel(d.id)));
  }
  setDialogTab(key: string | null, tab: number | string) {
    const d = this.need(key);
    const i = typeof tab === 'number' ? tab : d.spec.tabs.findIndex(t => t.name.toLowerCase() === String(tab).toLowerCase());
    if (i < 0 || i >= d.spec.tabs.length) throw new CommandError('not_found', `${d.id} has no tab ${tab}`);
    this.replace({...d, tab: i});
  }
  /** Reset every field to the spec defaults ("Reset" / the defaults button). */
  resetDialog(key: string | null) {
    const d = this.need(key);
    const fresh = createDialogState(d.spec, {init: null, pending: d.pending, key: d.key, parent: d.parent, target: d.target, args: d.args, origin: d.origin});
    this.replace({...fresh, tab: d.tab, initial: d.initial});
  }

  cancelDialog(key?: string | null) {
    const d = this.need(key);
    this.waiters.get(d.key)?.(null);
    this.waiters.delete(d.key);
    const dialogs = this.state.dialogs.filter(x => x.key !== d.key && x.parent !== d.key);
    const patch: Partial<ShellState> = {dialogs};
    if (this.state.backstage.page === `dialog:${d.key}`) patch.backstage = {open: false, page: null};
    this.set(patch);
    if (!dialogs.length) this.focusSurface();
  }

  /** Press a footer button (OK, Apply, Save, Don't Save...) — `ui.dialog.submit {button}`. */
  async submitDialog(key?: string | null, buttonId?: string | null, opts: {origin?: 'ui' | 'bridge'; approval?: {nonce: string}} = {}): Promise<{ok: boolean; result?: ExecResult | null; errors?: unknown[]}> {
    this.execOpts = {origin: opts.origin === 'bridge' ? 'bridge' : 'dialog', approval: opts.approval, rethrow: opts.origin === 'bridge'};
    try { return await this.submitDialogNow(key, buttonId); } finally { this.execOpts = {origin: 'dialog', rethrow: false}; }
  }

  private async submitDialogNow(key?: string | null, buttonId?: string | null): Promise<{ok: boolean; result?: ExecResult | null; errors?: unknown[]}> {
    const d = this.need(key);
    const btn = buttonId ? d.spec.buttons.find(b => b.id === buttonId || norm(b.label) === norm(buttonId)) : d.spec.buttons.find(b => b.role === 'ok') ?? d.spec.buttons[0];
    if (buttonId && !btn) throw new CommandError('not_found', `${d.id} has no button ${buttonId}`);
    const role = btn?.role ?? 'ok';
    if (role === 'cancel') { this.cancelDialog(d.key); return {ok: true}; }
    if (role === 'help') { this.notify(`${d.spec.title}: help is not available offline`); return {ok: true}; }
    const model = this.dialogModel(d.id);
    if (role === 'other') {
      const handler = model?.buttons ? Object.entries(model.buttons).find(([k]) => norm(k) === norm(btn!.id) || norm(k) === norm(btn!.label))?.[1] : undefined;
      const call = handler ? handler(this.session.readContext(this.docId) as any, d.values) : btn?.command && this.hasCommand(btn.command) ? {command: btn.command, params: {}} : null;
      if (!call) {
        if (d.pending) throw new CommandError('unavailable', `Not translated yet: ${d.id}`);
        return {ok: false};
      }
      const result = await this.execDialogCall(d, call);
      if (result === undefined) return {ok: false};
      if ('close' in call && call.close) this.closeDialog(d.key);
      else if (!allFields(d.spec).some(f => !['label', 'preview', 'button', 'message'].includes(f.kind))) this.closeDialog(d.key);
      else this.refreshDialog(d.key);
      return {ok: true, result};
    }
    if (d.pending) {
      const next = {...d, message: `Not translated yet: ${d.spec.command ?? d.id}`};
      this.replace(next);
      throw new CommandError('unavailable', next.message!);
    }
    const errors = validateState(d, model);
    if (errors.length) {
      this.replace({...d, errors, tab: tabOf(d, errors[0].field), message: errors[0].message});
      return {ok: false, errors};
    }
    const waiter = this.waiters.get(d.key);
    if (waiter) { this.waiters.delete(d.key); this.closeDialog(d.key); waiter(d.values); return {ok: true}; }
    // A nested dialog that returns a value to its parent's field (More Colors).
    if (d.target) {
      const v = d.values.color ?? d.values.value ?? null;
      this.closeDialog(d.key);
      if (v !== null) this.setDialogValue(d.target.dialog, d.target.field, v);
      return {ok: true};
    }
    const sub = submission(d, model);
    if (!sub) { if (role === 'ok') this.closeDialog(d.key); return {ok: true}; }
    const result = await this.execDialogCall(d, sub);
    if (result === undefined) return {ok: false};
    if (role === 'ok') this.closeDialog(d.key);
    else this.replace({...this.need(d.key), initial: this.need(d.key).values, message: null});
    return {ok: true, result};
  }

  /** A `button` field inside the dialog: a nested dialog, the model's handler, or its command. */
  async pressField(key: string | null, fieldId: string): Promise<ExecResult | null> {
    this.execOpts = {origin: 'dialog', rethrow: false};
    const d = this.need(key);
    const f = allFields(d.spec).find(x => x.id === fieldId);
    if (!f) throw new CommandError('not_found', `${d.id} has no field ${fieldId}`);
    if (f.dialog) { this.openDialog(f.dialog, {parent: d.key}); return null; }
    const model = this.dialogModel(d.id);
    const handler = model?.buttons?.[f.id] ?? (model?.buttons ? Object.entries(model.buttons).find(([k]) => norm(k) === norm(f.id) || norm(k) === norm(f.label))?.[1] : undefined);
    const call = handler ? handler(this.session.readContext(this.docId) as any, d.values) : f.command && this.hasCommand(f.command) ? {command: f.command, params: {}} : null;
    if (!call) {
      if (d.pending || (f.command && !this.hasCommand(f.command))) { this.replace({...d, message: `Not translated yet: ${f.command ?? f.id}`}); return null; }
      return null;
    }
    const r = await this.execDialogCall(d, call);
    this.refreshDialog(d.key);
    return r ?? null;
  }

  private async execDialogCall(d: DialogState, call: {command: string; params: object; close?: boolean} | {batch: {command: string; params: object}[]}): Promise<ExecResult | null | undefined> {
    // OK with nothing changed (Table Properties, Format Cells...): the dialog just closes, as in Office.
    if ('batch' in call && !call.batch.length) { this.execOpts = {origin: 'dialog', approval: undefined, rethrow: false}; return null; }
    this.replace({...d, busy: true, message: null});
    const {origin, approval, rethrow} = this.execOpts;
    this.execOpts = {origin: 'dialog', approval: undefined, rethrow: false};
    try {
      const result = 'batch' in call
        ? await this.session.batch(this.docId, call.batch, {origin, label: d.spec.title, approval})
        : await this.session.execute(this.docId, call.command, call.params ?? {}, {origin, approval});
      const cur = this.dialog(d.key);
      if (cur) this.replace({...cur, busy: false});
      return result;
    } catch (e) {
      const err = toCommandError(e);
      const cur = this.dialog(d.key);
      const fields = (err.data as any)?.fields as {field: string; message: string}[] | undefined;
      if (cur) this.replace({...cur, busy: false, message: err.message, errors: fields ?? cur.errors, tab: fields?.length ? tabOf(cur, fields[0].field) : cur.tab});
      if (rethrow || d.origin === 'bridge') throw err;
      return undefined;
    }
  }

  private closeDialog(key: string) {
    const d = this.dialog(key);
    if (!d) return;
    const dialogs = this.state.dialogs.filter(x => x.key !== key && x.parent !== key);
    const patch: Partial<ShellState> = {dialogs};
    if (this.state.backstage.page === `dialog:${key}`) patch.backstage = {open: false, page: null};
    this.set(patch);
    if (!dialogs.length && !d.parent) this.focusSurface();
  }
  /** After an in-dialog button changed the document, re-read values the person has not edited. */
  private refreshDialog(key: string) {
    const d = this.dialog(key);
    const model = d && this.dialogModel(d.id);
    if (!d || !model) return;
    try {
      const fresh = model.init(this.session.readContext(this.docId) as any);
      const edited = new Set(changedFields(d));
      const values = {...d.values};
      for (const [k, v] of Object.entries(fresh)) if (!edited.has(k)) values[k] = v;
      this.replace({...d, values, initial: {...d.initial, ...fresh}});
    } catch { /* keep the values */ }
  }

  private dialogKey(_chord: Chord, text: string): boolean | 'pass' {
    const top = this.state.dialogs.filter(d => d.spec.presentation === 'modal' || d.spec.presentation === 'full-window').at(-1);
    if (!top) return false;
    if (!this.feeding) return 'pass';             // the dialog's own DOM handles Enter, Esc and Tab
    if (text === 'Escape') { this.cancelDialog(top.key); return true; }
    if (text === 'Enter') { void this.submitDialog(top.key).catch(() => {}); return true; }
    return 'pass';
  }

  // -------------------------------------------------------------------------------------------
  // Panes (section 10)

  paneSpec(id: string): SpecPane | null { return this.model?.spec.panes.find(p => p.id === id || p.id === `pane.${id}`) ?? null; }
  paneModule(id: string): LazyModule | null { return this.ui.panes[id] ?? this.ui.panes[id.replace(/^pane\./, '')] ?? null; }
  paneImplemented(id: string): boolean {
    return !!this.paneModule(id);
  }
  setPane(id: string, open?: boolean) {
    const spec = this.paneSpec(id);
    if (!spec) throw new CommandError('not_found', `No pane ${id}`);
    if (!this.paneImplemented(spec.id) && !SHOW_PENDING) throw new CommandError('unavailable', `Not translated yet: ${spec.id}`);
    const cur = this.state.panes.find(p => p.id === spec.id);
    const want = open ?? !cur?.open;
    const dock: PaneState['dock'] = spec.side === 'start' || spec.side === 'left' ? 'left' : spec.side === 'float' ? 'float' : 'right';
    const panes = cur ? this.state.panes.map(p => (p.id === spec.id ? {...p, open: want} : p))
      : [...this.state.panes, {id: spec.id, open: want, dock, width: spec.width ?? 300}];
    this.set({panes});
  }
  resizePane(id: string, width: number) {
    this.set({panes: this.state.panes.map(p => (p.id === id ? {...p, width: Math.max(200, Math.min(640, Math.round(width)))} : p))});
  }
  dockPane(id: string, dock: PaneState['dock']) { this.set({panes: this.state.panes.map(p => (p.id === id ? {...p, dock} : p))}); }

  // -------------------------------------------------------------------------------------------
  // Keys and keytips (section 11)

  private feeding = false;
  /** Dialogs opened by host.openDialog: OK returns the values instead of running the command. */
  private waiters = new Map<string, (v: Values | null) => void>();
  /** Open a dialog to gather values (Host.openDialog); resolves with the values on OK, null on Cancel. */
  collectDialog(id: string, init: Values = {}): Promise<Values | null> {
    const key = this.openDialog(id, {init});
    return new Promise(resolve => this.waiters.set(key, resolve));
  }
  /** `ui.key`: route a chord or sequence through the KeyRouter with no DOM event. */
  key(keys: string) {
    if (/^(esc|escape)$/i.test(keys.trim()) && this.state.backstage.open && !this.state.dialogs.length) {
      this.closeBackstage();
      return [{handled: true, scope: 'app' as const}];
    }
    this.feeding = true;
    try { return this.router.feed(keys); } finally { this.feeding = false; }
  }

  /** Does the document surface have the keyboard (no dialog, backstage, menu or keytips in front of it)? */
  surfaceHasKeys(): boolean {
    const st = this.state;
    return !!this.view && !st.backstage.open && !st.dialogs.some(d => d.spec.presentation === 'modal') && st.keytips.phase === 'off' && !st.menu;
  }

  /**
   * `ui.key` with the surface in the loop, in the order a keystroke takes in the window: keys a
   * focused editing field owns (typing, caret, Backspace/Delete, Ctrl+Z... `fieldOwns`) go to the
   * surface first and reach the shortcut table only when the surface leaves them; every other chord
   * goes to the shortcut table first and reaches the surface only when nothing is bound to it
   * (Escape, F2, Enter in a grid...). A surface with only deckcraft's `key` is asked first for every
   * chord (deckcraft `Session::key`: engine keys, then the registry's shortcuts). One chord per step.
   */
  async keyWithSurface(keys: string): Promise<{handled: boolean; command: string | null; scope: string | null; by: 'surface' | 'shortcut' | null}[]> {
    if (!this.view?.keys && !this.view?.key) {
      // A surface without key handlers: the whole sequence goes through the shortcut table at once.
      const r = this.key(keys);
      const last = r[r.length - 1] as any;
      return [{handled: r.some(x => x.handled), command: last?.binding?.command ?? null, scope: last?.scope ?? null, by: r.some(x => x.handled) ? 'shortcut' : null}];
    }
    const steps = parseShortcut(keys)[0]?.steps;
    if (!steps?.length) throw new CommandError('invalid_params', `Cannot parse keys "${keys}"`, {path: '/keys'});
    const out: {handled: boolean; command: string | null; scope: string | null; by: 'surface' | 'shortcut' | null}[] = [];
    const mac = platform() === 'mac';
    for (const step of steps) {
      const chord = {...step} as Chord;
      if (chord.mod) { chord.mod = false; if (mac) chord.meta = true; else chord.ctrl = true; }
      const text = chordText(chord, platform());
      const viaRouter = () => {
        const r = this.key(text);
        const last = r[r.length - 1] as any;
        return {handled: r.some(x => x.handled), command: last?.binding?.command ?? null, scope: last?.scope ?? null, by: r.some(x => x.handled) ? 'shortcut' as const : null};
      };
      const viaSurface = async () => {
        if (!this.surfaceHasKeys()) return null;
        const r = await surfaceKey(this.view!, chord);
        return r && r.handled ? {handled: true, command: r.command, scope: 'surface', by: 'surface' as const} : null;
      };
      // deckcraft's `Session::key` (a surface registering `key` without `keys`) asks the engine's keys
      // before the registry's shortcuts for every chord.
      const surfaceFirst = typeof this.view?.keys !== 'function' || fieldOwns(text, true);
      if (surfaceFirst) {
        out.push((await viaSurface()) ?? viaRouter());
      } else {
        const r = viaRouter();
        out.push(r.handled ? r : (await viaSurface()) ?? r);
      }
    }
    return out;
  }

  bindings(): Binding[] {
    const out: Binding[] = [];
    const mac = platform() === 'mac';
    for (const s of this.model?.spec.shortcuts ?? []) {
      const keys = mac && s.mac ? s.mac : s.keys;
      if (s.command && !this.hasCommand(s.command)) continue;
      if (!s.command && s.dialog && !this.dialogImplemented(s.dialog)) continue;
      out.push({keys, command: s.command, dialog: s.dialog, args: s.args, scope: s.context || 'app', source: 'spec'});
    }
    for (const c of this.model?.controls.values() ?? []) {
      if (!c.shortcut || !c.command || !this.hasCommand(c.command)) continue;
      out.push({keys: c.shortcut, command: c.command, dialog: c.dialog, args: concreteArgs(c.args), scope: 'app', source: 'control', control: c.id});
    }
    for (const cmd of this.session.registry.list()) {
      if (!cmd.shortcut) continue;
      for (const k of Array.isArray(cmd.shortcut) ? cmd.shortcut : [cmd.shortcut]) out.push({keys: k, command: cmd.id, scope: cmd.shortcutContext ?? 'app', source: 'command'});
    }
    out.push({keys: 'Mod+F1', command: 'ui.collapseRibbon', scope: 'app', source: 'shell'});
    out.push({keys: 'Alt+Q', command: 'ui.search', scope: 'app', source: 'shell'});
    return out;
  }

  /** Keytips for the current phase: tab letters, or the active tab's control letters. */
  keytipTable(): Map<string, string> {
    const st = this.state.keytips;
    if (st.phase === 'tabs') {
      const tabs = this.visibleTabs();
      const fromModel = this.model?.tabKeytips ?? new Map();
      const out = new Map<string, string>([['#file', fromModel.get('#file') ?? 'F']]);
      const missing = tabs.filter(t => !fromModel.has(t.id));
      for (const t of tabs) if (fromModel.has(t.id)) out.set(t.id, fromModel.get(t.id)!);
      if (missing.length) for (const [k, v] of assignKeytips(missing.map(t => ({id: t.id, label: t.label})), out.values())) out.set(k, v);
      qatKeytips(this.qat().length).forEach((tip, i) => out.set(`#qat:${this.qat()[i].id}`, tip));
      return out;
    }
    if (st.phase === 'commands') {
      const tab = this.activeTab();
      const items: {id: string; label: string; preferred?: string | null}[] = [];
      for (const g of tab?.groups ?? []) {
        if (!this.groupShows(g)) continue;
        if (this.state.levels[g.key] === 3) { items.push({id: `#group:${g.key}`, label: g.label, preferred: g.keytip}); continue; }
        for (const c of g.controls) if (isControl(c) && this.shows(c)) items.push({id: c.id, label: displayLabel(c), preferred: (c.keytip as string) ?? null});
        // Office gives a launcher the group's letters (Word Home: Font FN, Paragraph PG); a collapsed
        // group and its launcher are never on screen together, so they share the overlay's keytip.
        if (g.launcher) items.push({id: `#launcher:${g.key}`, label: `${g.label} settings`, preferred: g.keytip ?? null});
      }
      return assignKeytips(items);
    }
    return new Map();
  }
  toggleKeytips() {
    if (this.state.keytips.phase !== 'off') { this.set({keytips: KEYTIPS_OFF}); return; }
    if (this.state.dialogs.some(d => d.spec.presentation === 'modal')) return;
    this.set({keytips: {phase: 'tabs', tab: null, typed: ''}, menu: null});
  }
  private keytipKey(_chord: Chord, text: string): boolean {
    const st = this.state.keytips;
    if (text === 'Escape') {
      this.set({keytips: st.phase === 'commands' ? {phase: 'tabs', tab: null, typed: ''} : KEYTIPS_OFF});
      return true;
    }
    const letter = /^[A-Z0-9]$/.test(text) ? text : null;
    if (!letter) { this.set({keytips: KEYTIPS_OFF}); return true; }
    const typed = st.typed + letter;
    const table = this.keytipTable();
    const m = matchKeytip(table, typed);
    if (m.kind === 'wait') { this.set({keytips: {...st, typed}}); return true; }
    if (m.kind !== 'match') { this.set({keytips: {...st, typed: ''}}); return true; }
    const id = m.id;
    if (st.phase === 'tabs') {
      if (id === '#file') { this.set({keytips: KEYTIPS_OFF}); this.openBackstage(); return true; }
      if (id.startsWith('#qat:')) { this.set({keytips: KEYTIPS_OFF}); void this.activate(id.slice(5)).catch(e => this.notify(toCommandError(e).message, 'error')); return true; }
      this.setTab(id);
      this.set({keytips: {phase: 'commands', tab: id, typed: ''}});
      return true;
    }
    this.set({keytips: KEYTIPS_OFF});
    if (id.startsWith('#group:')) { this.setGroupMenu(id.slice(7)); return true; }
    if (id.startsWith('#launcher:')) { void this.launch(id.slice(10)); return true; }
    const c = this.model?.controls.get(id);
    if (c && (c.type === 'menu' || c.type === 'gallery' || (c.type === 'split' && !c.command))) { this.setMenu(c.id); return true; }
    if (c && c.type === 'combo') { this.set({menu: `focus:${c.id}`}); return true; }
    void this.activate(id).catch(e => this.notify(toCommandError(e).message, 'error'));
    return true;
  }

  /** A group's launcher (the corner arrow): its dialog, pane or command. */
  async launch(groupKey: string) {
    const g = this.activeTab()?.groups.find(x => x.key === groupKey) ?? this.model?.tabs.flatMap(t => t.groups).find(x => x.key === groupKey);
    const l = g?.launcher;
    if (!l) return;
    try {
      if (l.dialog && (this.dialogImplemented(l.dialog) || SHOW_PENDING)) { this.openDialog(l.dialog, {args: concreteArgs(l.args)}); return; }
      if (l.pane && this.paneSpec(l.pane)) { this.setPane(l.pane); return; }
      if (l.command) await this.run(l.command, l.args, {origin: 'ui'});
    } catch (e) { this.notify(toCommandError(e).message, 'error'); }
  }
  launcherImplemented(g: RibbonGroup): boolean {
    const l = g.launcher;
    if (!l) return false;
    if (l.dialog && this.dialogImplemented(l.dialog)) return true;
    if (l.pane && this.paneImplemented(l.pane)) return true;
    return !!l.command && this.hasCommand(l.command);
  }

  // -------------------------------------------------------------------------------------------
  // Inspection (section 8.8)

  inspect() {
    const st = this.state;
    const tab = this.activeTab();
    let doc: any = null;
    try { const d = this.session.get(this.docId); doc = {id: d.id, version: d.version, dirty: d.dirty, title: d.file.title, zoom: d.view.zoom, fit: d.view.fit}; } catch { /* closed */ }
    const describe = (c: SpecControl, group: RibbonGroup | null) => {
      const s = this.controlState(c);
      return {id: c.id, label: displayLabel(c), type: c.type, command: c.command, args: c.args, enabled: s.enabled, reason: s.reason ?? null,
        checked: s.checked ?? null, value: s.value ?? null, pending: s.pending, collapsed: group ? st.levels[group.key] === 3 : false, group: group?.id ?? null,
        ...(group && group.tab !== tab?.id ? {tab: group.tab} : {})};
    };
    // Groups an app's own chrome draws outside the active tab (its rails and bars), as it reported them.
    const own = new Set((tab?.groups ?? []).map(g => g.key));
    const chrome = Object.keys(st.levels).filter(k => !own.has(k))
      .map(k => this.model?.tabs.flatMap(t => t.groups).find(g => g.key === k)).filter((g): g is RibbonGroup => !!g);
    return {
      app: this.kind, doc, tab: tab?.id ?? null, tabs: this.visibleTabs().map(t => t.id),
      contextualTabs: this.contextualTabs().map(t => t.id), flags: st.flags,
      backstage: st.backstage, ribbon: st.ribbon, menu: st.menu, keytips: st.keytips, panel: st.panel,
      controls: [...(tab?.groups ?? []), ...chrome].filter(g => this.groupShows(g)).flatMap(g => g.controls.filter(isControl).filter(c => this.shows(c)).map(c => describe(c, g))),
      qat: this.qat().map(c => describe(c, null)),
      dialog: this.dialog() ? snapshot(this.dialog()!) : null,
      dialogs: st.dialogs.map(snapshot),
      panes: st.panes,
      levels: st.levels,
      showPending: SHOW_PENDING,
    };
  }

  /** The shell model's version (bumps when customization changes the ribbon). */
  get version() { return this.ribbonVersion; }
}

/** DOM key names for the chord keys KeyRouter writes ('Left' -> 'ArrowLeft'). */
const DOM_KEYS: Record<string, string> = {Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', Space: ' ', Esc: 'Escape', Del: 'Delete', Menu: 'ContextMenu'};

/** Hand one chord to the surface's key handler; null when it has none. */
async function surfaceKey(view: SurfaceHandle, chord: Chord): Promise<{handled: boolean; command: string | null} | null> {
  const key = DOM_KEYS[chord.key] ?? (/^[A-Z]$/.test(chord.key) && !chord.shift ? chord.key.toLowerCase() : chord.key);
  const mods = {shift: !!chord.shift, ctrl: !!chord.ctrl, alt: !!chord.alt, meta: !!chord.meta};
  let r: any;
  if (typeof view.keys === 'function') r = await view.keys(key, Object.entries(mods).filter(([, on]) => on).map(([k]) => k));
  else if (typeof view.key === 'function') r = await view.key(key, {...mods, cmd: platform() === 'mac' ? mods.meta : mods.ctrl});
  else return null;
  if (!r || typeof r !== 'object') return {handled: r === true, command: null};
  const command = typeof r.command === 'string' ? r.command : Array.isArray(r.commands) && typeof r.commands[r.commands.length - 1] === 'string' ? r.commands[r.commands.length - 1] : null;
  return {handled: r.handled === true, command};
}

/** Backstage pages the shell draws itself (src/shell/backstage/pages.tsx). */
export const BUILTIN_PAGES = new Set(['info', 'home', 'save-as', 'saveas', 'saveAs', 'save-copy', 'savecopy', 'saveCopy', 'export', 'download', 'recover',
  'print', 'options', 'account', 'about', 'help', 'new', 'open']);
export type BuiltinPage = 'info' | 'home' | 'saveCopy' | 'saveAs' | 'export' | 'recover' | 'print' | 'options' | 'account' | 'new' | 'open';

/** Which of the shell's own File pages a backstage node is (by id stem or label), or null. */
export function builtinPageKey(node: {id: string; label: string}): BuiltinPage | null {
  const s = node.id.replace(/^file\./, '').replace(/^backstage\./, '').toLowerCase(), l = String(node.label ?? '').toLowerCase();
  if (s === 'info' || l === 'info') return 'info';
  if (s === 'home' || l === 'home') return 'home';
  // Office: Save As and Save a Copy are places (This PC, Browse = the system Save dialog); Export is Change File Type.
  if (/^(save-?copy|savecopy)$/.test(s) || l === 'save a copy') return 'saveCopy';
  if (/^(save-?as|saveas)$/.test(s) || l === 'save as') return 'saveAs';
  if (/^(export|download)$/.test(s) || l === 'export') return 'export';
  if (s === 'recover' || /^recover/.test(l)) return 'recover';
  if (s === 'print' || /^print[.…]*$/.test(l)) return 'print';
  if (s === 'options' || l === 'options' || /preferences/.test(l)) return 'options';
  if (/^(account|about|help)$/.test(s) || /^(account|about)$/.test(l)) return 'account';
  if (s === 'new' || l === 'new') return 'new';
  if (s === 'open' || l === 'open') return 'open';
  return null;
}

/**
 * Interface commands the shell answers itself (`ui.*` ids the specs name for chrome behaviour:
 * the ribbon toggle, the command search, the backstage). They are view state, never document edits.
 */
const UI_COMMANDS: Record<string, (c: ShellController, p: Args) => null> = {
  'ui.collapseRibbon': c => { c.toggleRibbonCollapsed(); return null; },
  'ui.search': c => { c.setMenu('search'); return null; },
  'ui.backstage': (c, p) => { c.openBackstage(typeof p.page === 'string' ? `file.${p.page}` : null); return null; },
  'ui.keytips': c => { c.toggleKeytips(); return null; },
};

function readPrefs(key?: string): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(key ?? '') ?? '{}') ?? {}; } catch { return {}; }
}
function writePrefs(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify({...(readPrefs(key) as object), ...(value as object)})); } catch { /* storage unavailable */ }
}

export function storedPrefs(kind: string): Record<string, unknown> { return readPrefs(`arkemis.prefs.${kind}`); }
export type {SpecField};
export {buildShellModel};
