// Types for core/kernel/session.mjs (docs/architecture.md section 4.1).
import type {AppId, Address, CommandId, ControlState, Origin, Prefs, Selection, StudioFile} from './command.mjs';
import type {Registry} from './registry.mjs';
import type {Host} from './host.mjs';
import type {UndoStack} from './undo.mjs';
import type {AnchorTable} from './anchors.mjs';
import type {ApprovalStore} from './risk.mjs';

export type DocId = string;

export interface DocState {
  id: DocId;
  file: StudioFile;          // metadata + content (content is the app model, immutable)
  version: number;           // +1 per committed transaction, never reused
  storeRevision: number;     // last revision written to / read from the store
  undo: UndoStack; redo: UndoStack;
  selection: Selection;
  anchors: AnchorTable;
  dirty: boolean;
  view: {zoom: number; fit: string | null; [key: string]: unknown};
  lastCommand: {command: CommandId; params: object} | null;
}

export interface ExecOpts {
  origin: Origin; baseVersion?: number; approval?: {nonce: string}; signal?: AbortSignal; dryRun?: boolean;
}
export interface ExecResult {
  result: unknown; version: number | null; changed: Address[]; undoLabel?: string; selection?: Selection; dryRun?: boolean;
}
export type SessionEvent =
  | {type: 'doc.changed'; doc: DocId; version: number; changed: Address[]; origin: string; command?: string; undoLabel?: string; history?: 'undo' | 'redo'; reloaded?: boolean}
  | {type: 'selection.changed'; doc: DocId; version: number; origin: string; selection: Selection}
  | {type: 'view.changed'; doc: DocId; version: number; view: DocState['view']}
  | {type: 'doc.saved'; doc: DocId; version: number; storeRevision: number}
  | {type: 'document.opened' | 'document.closed'; doc: DocId; version: number}
  | {type: 'prefs.changed'; prefs: Prefs};
export type CommitMessage =
  | {doc: DocId; ops: unknown[]; label?: string; command?: string; origin?: string}
  | {doc: DocId; history: 'undo' | 'redo'; count: number; origin?: string}
  | {doc: DocId; saved: true; origin?: string};

export interface Foundation {
  schema?: {apply?(content: unknown, op: unknown): {content: unknown; inverse: unknown}; [key: string]: unknown};
  address?: Record<string, unknown>;
  context?: {flags?: string[]; evaluate?(content: unknown, selection: Selection, prefs: Prefs): Record<string, boolean>};
  migrate?: Record<string, unknown>;
  model?: unknown;
  fixtures?: Record<string, () => unknown>;
  /** Checks around every command that edits the document (an app's `hooks.mjs`). */
  hooks?: {before?(ctx: unknown, cmd: unknown, params: unknown): unknown; after?(ctx: unknown, cmd: unknown, params: unknown, state: unknown): void};
  spec?: {app: AppId; tabs: string[]; contextualTabs: string[]; qat: string[]} | null;
}

export interface Session {
  app: AppId;
  registry: Registry;
  host: Host;
  foundation: Foundation;
  docs: Map<DocId, DocState>;
  activeDocId: DocId | null;
  clipboard: unknown;
  prefs: Prefs;
  approvals: ApprovalStore;
  journal: {time: number; doc: DocId | null; command: CommandId; params: object; origin: Origin; version: number | null}[];
  readonly tick: number;
  open(file: StudioFile, opts?: {activate?: boolean; selection?: Selection}): DocId;
  close(docId: DocId): boolean;
  get(docId?: DocId | null): DocState;
  activate(docId: DocId): void;
  execute(docId: DocId | null, id: CommandId, params?: object, opts?: Partial<ExecOpts>): Promise<ExecResult>;
  batch(docId: DocId, steps: {command: CommandId; params?: object}[], opts?: Partial<ExecOpts> & {label?: string}): Promise<ExecResult>;
  undo(docId: DocId | null, count?: number, opts?: {origin?: Origin}): Promise<ExecResult>;
  redo(docId: DocId | null, count?: number, opts?: {origin?: Origin}): Promise<ExecResult>;
  state(docId: DocId | null, id: CommandId, params?: object): ControlState;
  setSelection(docId: DocId | null, selection: Selection, opts?: {origin?: Origin}): void;
  anchor(docId: DocId | null, address: Address): string;
  where(docId: DocId | null, address: Address): {address: Address} | {deleted: true; nearest: Address | null};
  resolve(docId: DocId | null, address: Address): unknown;
  read(docId: DocId | null, address: Address, as?: string): unknown;
  readContext(docId?: DocId | null, origin?: Origin): import('./command.mjs').Ctx;
  contextFlags(docId?: DocId | null): Record<string, boolean>;
  reload(docId: DocId, file: StudioFile): void;
  subscribe(listener: (e: SessionEvent) => void): () => void;
  /** Committed changes with their operations (View › New Window keeps another window in step). */
  onCommit(listener: (msg: CommitMessage) => void): () => void;
  /** Apply another window's committed change, undo/redo or save on the same document. */
  mirror(docId: DocId, msg: CommitMessage): Promise<unknown>;
}

export declare const JOURNAL_LIMIT: number;
export declare function createSession(opts: {
  app: AppId; registry: Registry; host?: Host; foundation?: Foundation; prefs?: Prefs; undoLimit?: number; approvals?: ApprovalStore;
}): Session;
