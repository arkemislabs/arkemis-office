// Types for core/kernel/undo.mjs.
import type {Selection} from './command.mjs';

export interface UndoEntry {
  label: string; origin: string; forward: object[]; inverse: object[];
  selectionBefore?: Selection; selectionAfter?: Selection; time: number; command?: string; mergeKey?: string; versionAfter?: number;
}
export declare const DEFAULT_UNDO_LIMIT: number;
export declare const MERGE_WINDOW_MS: number;
export declare class UndoStack {
  constructor(opts?: {limit?: number});
  limit: number;
  entries: UndoEntry[];
  readonly size: number;
  readonly canPop: boolean;
  peek(): UndoEntry | null;
  push(entry: UndoEntry): void;
  pop(): UndoEntry | null;
  clear(): void;
  labels(): string[];
}
export declare function undoLabel(label: string, origin: string): string;
export declare function combineEntries(entries: UndoEntry[], label: string, origin: string): UndoEntry | null;
