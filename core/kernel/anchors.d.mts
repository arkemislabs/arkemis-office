// Types for core/kernel/anchors.mjs (docs/architecture.md section 4.3).
export declare const ANCHOR_LIMIT: number;
export declare class AnchorTable {
  constructor(opts?: {limit?: number});
  readonly size: number;
  create(ast: object): string;
  get(id: string): {ast: object | null; deleted: boolean; nearest?: object | null};
  has(id: string): boolean;
  delete(id: string): boolean;
  mapThrough(ops: object[], mapThrough: (op: object, ast: object) => object | {deleted: true; nearest?: object}): void;
  toJSON(format?: (ast: object) => string): Record<string, unknown>;
}
