// Undo/redo stacks with labels, origin tags, groups and typing merges
// (docs/architecture.md section 4.2). No DOM, no Node built-ins.
//
// An entry records the forward ops a commit applied and their inverses; undo applies `inverse`,
// redo applies `forward`. Bridge edits carry the label "Automation: <label>" so the person sees
// them in the app's Undo list.

export const DEFAULT_UNDO_LIMIT = 500;
export const MERGE_WINDOW_MS = 1000;

/**
 * @typedef {{label: string, origin: string, forward: object[], inverse: object[],
 *   selectionBefore?: object, selectionAfter?: object, time: number, command?: string,
 *   mergeKey?: string, versionAfter?: number}} UndoEntry
 */

export class UndoStack {
  constructor({limit = DEFAULT_UNDO_LIMIT} = {}) {
    this.limit = limit;
    /** @type {UndoEntry[]} */
    this.entries = [];
  }
  get size() { return this.entries.length; }
  get canPop() { return this.entries.length > 0; }
  peek() { return this.entries[this.entries.length - 1] || null; }
  /** Push an entry, merging it into the top entry when both carry the same mergeKey within the window. */
  push(entry) {
    const top = this.peek();
    if (top && entry.mergeKey && top.mergeKey === entry.mergeKey && entry.time - top.time <= MERGE_WINDOW_MS) {
      this.entries[this.entries.length - 1] = {
        ...top,
        forward: [...top.forward, ...entry.forward],
        inverse: [...entry.inverse, ...top.inverse],
        selectionAfter: entry.selectionAfter,
        time: entry.time,
        versionAfter: entry.versionAfter,
      };
      return;
    }
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }
  pop() { return this.entries.pop() || null; }
  clear() { this.entries.length = 0; }
  /** Labels newest first (the Undo dropdown: "Undo 3 Actions"). */
  labels() { return this.entries.map(e => e.label).reverse(); }
}

/** The label the Undo list shows for a commit. */
export function undoLabel(label, origin) {
  return origin === 'bridge' ? `Automation: ${label}` : label;
}

/** Collapse several entries (oldest first) into one, for batches and dialog groups. */
export function combineEntries(entries, label, origin) {
  if (!entries.length) return null;
  const first = entries[0], last = entries[entries.length - 1];
  return {
    label, origin,
    forward: entries.flatMap(e => e.forward),
    inverse: entries.slice().reverse().flatMap(e => e.inverse),
    selectionBefore: first.selectionBefore,
    selectionAfter: last.selectionAfter,
    time: last.time,
    versionAfter: last.versionAfter,
  };
}
