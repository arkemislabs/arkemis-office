// Types for core/kernel/address.mjs (docs/architecture.md section 14).
export interface Segment { kind: string; key?: string }
export type AddressAst = {anchor: string} | {segments: Segment[]};
export interface Addressing {
  generic: boolean;
  parse(input: string): AddressAst;
  format(ast: AddressAst): string;
  resolve(content: unknown, ast: AddressAst): {kind: string; node?: unknown; [key: string]: unknown};
  canonical(content: unknown, input: string): string;
  mapThrough(op: object, ast: AddressAst): AddressAst | {deleted: true; nearest?: AddressAst};
  enumerate(content: unknown, scope: AddressAst, opts: {depth: number; cursor?: string; limit: number}): {nodes: object[]; cursor?: string};
  read(content: unknown, ast: AddressAst, as: string): unknown;
  changed: ((ops: object[], content: unknown) => string[]) | null;
}
export declare const ADDRESS_GRAMMAR_VERSION: number;
export declare function parse(input: string): AddressAst;
export declare function format(ast: AddressAst): string;
export declare function isAnchor(input: unknown): boolean;
export declare function parseTextRange(key: string): {from: number; to: number};
export declare function assertCodeUnitBoundary(text: string, offset: number): void;
export declare function jsonPath(ast: {segments: Segment[]}): string[];
export declare const genericResolver: Omit<Addressing, 'generic' | 'changed'>;
export declare function createAddressing(appModule?: Record<string, unknown>): Addressing;
