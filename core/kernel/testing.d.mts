// Types for core/kernel/testing.mjs (docs/architecture.md section 17.1).
import type {Session, ExecResult, DocState, Foundation} from './session.mjs';
import type {CommandFamily, ControlState, StudioFile, Selection} from './command.mjs';
import type {ApprovalRequest} from './risk.mjs';

export interface TestSession {
  app: string;
  session: Session;
  host: import('./host.mjs').Host;
  registry: import('./registry.mjs').Registry;
  docId: string;
  readonly doc: DocState;
  readonly file: StudioFile;
  readonly content: any;
  readonly version: number;
  exec(id: string, params?: object, opts?: object): Promise<ExecResult>;
  bridge(id: string, params?: object, opts?: object): Promise<ExecResult>;
  batch(steps: {command: string; params?: object}[], opts?: object): Promise<ExecResult>;
  undo(n?: number): Promise<ExecResult>;
  redo(n?: number): Promise<ExecResult>;
  state(id: string, params?: object): ControlState;
  read(address: string, as?: string): unknown;
  anchor(address: string): string;
  where(address: string): unknown;
}
export declare class TestFailure extends Error {}
export declare const fixtures: Readonly<Record<string, () => object>>;
export declare function deepEqual(a: unknown, b: unknown): boolean;
export declare function firstDifference(a: unknown, b: unknown, path?: string): {path: string; expected: unknown; actual: unknown} | null;
export declare function createTestSession(app: string, opts?: {fixture?: string; file?: StudioFile; content?: object; modules?: CommandFamily[];
  sources?: string[]; foundation?: Foundation; prefs?: object; host?: object; selection?: Selection}): Promise<TestSession>;
export declare function expectUndoRoundTrip(t: TestSession, id: string, params?: object,
  check?: (after: {file: StudioFile; content: any; read(address: string, as?: string): unknown}, result: ExecResult) => unknown,
  opts?: {origin?: string; approval?: {nonce: string}}): Promise<ExecResult>;
export declare function expectApprovalRequired(t: TestSession, id: string, params?: object): Promise<ApprovalRequest>;
