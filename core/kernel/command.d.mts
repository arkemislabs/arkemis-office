// The command module contract (docs/architecture.md section 5.1).
import type {Schema} from './schema.mjs';

export type AppId = 'quill' | 'grid' | 'prism' | 'folio' | 'slate';
export type Address = string;
export type CommandId = string;
export type DialogId = string;
export type Path = (string | number)[] | string;

export type Risk = 'read' | 'edit' | 'destructive' | 'irreversible';
//  read         : no change (queries, inspection, zoom)                     -> never asks
//  edit         : undoable change to the open document                       -> never asks
//  destructive  : loses data outside the undo stack but recoverable          -> asks (Autopilot may skip)
//  irreversible : permanent, or leaves the machine / others see it           -> always asks
export type Origin = 'ui' | 'shortcut' | 'bridge' | 'test' | 'dialog';
/** What a command touches when it is not an undoable content change. */
export type Effect = 'content' | 'view' | 'persist' | 'prefs';

export interface Selection { ranges: {anchor: Address; focus: Address}[]; primary: number }
export interface ControlState {
  enabled: boolean; reason?: string; checked?: boolean | 'mixed';
  value?: unknown; /* font name, size, current color, gallery index */
}

export interface StudioFileMeta {
  id: string; schema: number; kind: AppId; title: string; revision: number;
  createdAt?: string; updatedAt?: string; starred?: boolean; links?: unknown[];
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface StudioFile<C = unknown> extends StudioFileMeta { content: C }

export interface ChangeApi {
  get(path: Path): unknown;
  /** Records {op:'set', path, value, old}. Paths are relative to the document content. */
  set(path: Path, value: unknown): void;
  delete(path: Path): void;
  splice(path: Path, index: number, remove: number, ...items: unknown[]): void;
  /** App-specific op through the app's schema.mjs `apply(content, op) -> {content, inverse}`. */
  apply(op: unknown): void;
  /** File metadata (title, starred, properties); never id/schema/kind/revision/content. */
  setMeta(key: string, value: unknown): void;
}

export interface Resolved { kind: string; node?: unknown; ast: unknown; address: Address; [key: string]: unknown }

export interface History {
  readonly canUndo: boolean; readonly canRedo: boolean; readonly undoDepth: number;
  undoLabels(): string[]; redoLabels(): string[];
  /** Schedules n undo steps after run() returns; returns how many will run. */
  undo(n?: number): number;
  redo(n?: number): number;
  readonly lastCommand: {command: string; params: object} | null;
}

export interface Ctx<Content = any, Model = any> {
  app: AppId; docId: string | null; origin: Origin;
  readonly doc: Readonly<Content>; readonly file: Readonly<StudioFile<Content>>;
  readonly version: number | null; readonly selection: Selection; readonly view: {zoom: number; fit: string | null; [k: string]: unknown} | null;
  prefs: Readonly<Prefs>;
  change: ChangeApi;                           // the only way to write
  resolve(address: Address): Resolved;         // app resolver; throws not_found
  setSelection(sel: Selection): void;
  setView(patch: object): void;                // session view state (zoom, fit); never undoable
  updatePrefs(patch: Partial<Prefs>): void;    // committed with the command, saved through host.savePrefs
  setUndoLabel(label: string): void;
  mergeUndo(key: string): void;                // typing merges consecutive entries with the same key
  markSaved(revision?: number): void;          // persistence commands
  closeAfter(): void;
  readonly dirty: boolean;
  history: History;
  run(id: CommandId, params: object): unknown; // compose other commands inside this transaction
  host: import('./host.mjs').Host; signal: AbortSignal;
  model: Model;                                // the app's foundation API (core/<app>/model)
  appInfo: AppInfo | null;                     // generated from the spec (tabs, QAT defaults)
  registry: import('./registry.mjs').Registry;
}

export interface AppInfo { app: AppId; tabs: string[]; contextualTabs: string[]; qat: string[] }
export interface Prefs { ribbon?: {tabs?: unknown[]; qat?: string[]}; autosave?: boolean; [key: string]: unknown }

export interface CommandSpec<P = any, R = any> {
  id: string;                         // spec commands[].id = upstream id verbatim, e.g. 'format.bold'
  label: string;                      // upstream label
  description?: string;               // one sentence; used by engine.commands
  shortcut?: string | string[];       // 'Mod+B'; 'Mod' = Ctrl on Windows, Cmd on macOS; 'Alt, V, P' is a key sequence
  /** KeyRouter scope the shortcut applies in (default 'app'); conflicts are checked per scope. */
  shortcutContext?: string;
  risk: Risk;
  /** Escalate the risk for particular params (file.save {path} is irreversible). */
  riskFor?(ctx: Ctx, p: P): Risk;
  needs?: 'model' | 'view' | 'worker'; // default 'model'; 'view' only in src/apps/*/ui-commands
  /** 'doc' (default) needs an open document; 'app' runs without one (ribbon customization). */
  scope?: 'doc' | 'app';
  effect?: Effect;                    // default 'content' for edits, 'view' for reads
  params: Schema<P>;
  result?: Schema<R>;
  /** Opened when the UI invokes it without its required params (or with no args at all). */
  dialog?: string;
  undo?: 'auto' | 'none';             // default 'auto' when effect is 'content' and risk is not 'read'
  journal?: boolean;                  // default true; secret params never journaled
  repeatable?: boolean;               // default true: edit.repeat may repeat it
  clearsHistory?: boolean;            // default false: the undo stack is emptied once it committed (it moved content out of the document)
  summary?(ctx: Ctx, p: P): string;   // approval text for destructive/irreversible
  state?(ctx: Ctx, p: Partial<P>): ControlState;
  run(ctx: Ctx, p: P): R | Promise<R>;
}

export interface CommandFamily {
  family: string;                     // path relative to commands/, e.g. 'format' or 'format/borders'
  app: AppId | AppId[] | '*';         // '*' only in core/common
  upstream: {repo: 'wordcraft' | 'gridcraft' | 'deckcraft' | 'printcraft' | 'office'; commit?: string; files: string[]};
  commands: CommandSpec[];
}

export interface RegisteredCommand extends CommandSpec {
  needs: 'model' | 'view' | 'worker'; undo: 'auto' | 'none'; journal: boolean; scope: 'doc' | 'app'; effect: Effect;
  family: string; familyApp: CommandFamily['app']; upstream: CommandFamily['upstream']; source: string | null;
}

export interface Chord { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; mod: boolean; key: string }

export declare const APP_IDS: readonly AppId[];
export declare const ORIGINS: readonly Origin[];
export declare const NEEDS: readonly ('model' | 'view' | 'worker')[];
export declare const EFFECTS: readonly Effect[];
export declare const SCOPES: readonly ('doc' | 'app')[];
export declare const UPSTREAM_REPOS: readonly string[];
export declare function defineCommands(f: CommandFamily): CommandFamily;
export declare function normalizeCommand<C extends CommandSpec>(c: C): C & Pick<RegisteredCommand, 'needs' | 'undo' | 'journal' | 'scope' | 'effect'>;
export declare function validateFamily(f: unknown, opts?: {where?: string; allowView?: boolean}): string[];
export declare function parseChord(text: string): Chord | null;
export interface ParsedShortcut { text: string; steps: Chord[] | null; chord: Chord | null; sequence: boolean }
export declare function parseShortcut(shortcut: string | string[] | null | undefined): ParsedShortcut[];
export declare function formatShortcut(entry: ParsedShortcut, platform?: 'mac' | 'win' | 'linux'): string;
export declare function formatChord(chord: Chord, platform?: 'mac' | 'win' | 'linux'): string;
