// Types for core/kernel/change.mjs (docs/architecture.md section 4.2).
import type {ChangeApi, Path} from './command.mjs';

export type Op =
  | {op: 'set'; path: (string | number)[]; value: unknown; old: unknown; had: boolean}
  | {op: 'delete'; path: (string | number)[]; old: unknown}
  | {op: 'splice'; path: (string | number)[]; index: number; remove: number; items: unknown[]; removed: unknown[]}
  | {op: 'app'; path: ['content']; forward: unknown; inverse: unknown};
export type AppApply = (content: unknown, op: unknown) => {content: unknown; inverse: unknown};

export declare function normPath(path: Path): (string | number)[];
export declare function getIn(root: unknown, path: Path): unknown;
export declare function applyOp<T>(root: T, op: Op, opts?: {owned?: WeakSet<object>; appApply?: AppApply}): T;
export declare function applyOps<T>(root: T, ops: Op[], opts?: {appApply?: AppApply}): T;
export declare function invertOp(op: Op): Op;
export declare function invertOps(ops: Op[]): Op[];
export declare function contentOp(op: Op): Op | null;
export declare function createTransaction<T extends {content: unknown}>(tree: T, opts?: {appApply?: AppApply; maxOps?: number}):
  {api: ChangeApi; ops: Op[]; readonly tree: T; readonly content: T['content']};
