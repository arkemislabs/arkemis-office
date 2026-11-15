// Types for core/kernel/schema.mjs.

export declare const SCHEMA: unique symbol;

export interface SchemaBase<T = unknown> {
  readonly type: 'string' | 'number' | 'boolean' | 'literal' | 'enum' | 'array' | 'object' | 'record' | 'union' | 'address' | 'color' | 'any';
  readonly optional?: boolean;
  readonly nullable?: boolean;
  readonly default?: unknown;
  readonly description?: string;
  readonly secret?: boolean;
  /** Phantom: the value type this schema accepts. */
  readonly __type?: T;
}
export type Schema<T = unknown> = SchemaBase<T>;
export type Infer<S> = S extends Schema<infer T> ? T : never;

type Opt<S> = S extends {optional: true} ? true : false;
type ObjectOf<P extends Record<string, Schema>> =
  { [K in keyof P as Opt<P[K]> extends true ? never : K]: Infer<P[K]> } &
  { [K in keyof P as Opt<P[K]> extends true ? K : never]?: Infer<P[K]> };

interface StringOpts { min?: number; max?: number; pattern?: string; description?: string; trim?: boolean }
interface NumberOpts { min?: number; max?: number; integer?: boolean; description?: string }
interface Described { description?: string }

export declare const s: {
  string(o?: StringOpts): Schema<string>;
  secret(o?: StringOpts): Schema<string>;
  number(o?: NumberOpts): Schema<number>;
  integer(o?: Omit<NumberOpts, 'integer'>): Schema<number>;
  boolean(o?: Described): Schema<boolean>;
  literal<const V extends string | number | boolean | null>(value: V, o?: Described): Schema<V>;
  enum<const V extends readonly (string | number)[]>(values: V, o?: Described): Schema<V[number]>;
  array<T>(items: Schema<T>, o?: {min?: number; max?: number; description?: string}): Schema<T[]>;
  object<P extends Record<string, Schema>>(properties?: P, o?: {additional?: boolean | Schema; description?: string}): Schema<ObjectOf<P>>;
  record<T>(values: Schema<T>, o?: {max?: number; description?: string}): Schema<Record<string, T>>;
  union<T extends Schema[]>(options: T, o?: Described): Schema<Infer<T[number]>>;
  optional<T>(inner: Schema<T>, defaultValue?: T): Schema<T> & {readonly optional: true};
  nullable<T>(inner: Schema<T>): Schema<T | null>;
  address(kind?: string, o?: Described): Schema<string>;
  color(o?: Described): Schema<string>;
  any(o?: Described): Schema<unknown>;
  describe<T>(inner: Schema<T>, description: string): Schema<T>;
};

export interface SchemaError { path: string; message: string }
export declare function isSchema(x: unknown): x is Schema;
export declare function validate<T>(schema: Schema<T>, value: unknown, opts?: {partial?: boolean}):
  {ok: true; value: T} | {ok: false; errors: SchemaError[]};
export declare function parse<T>(schema: Schema<T>, value: unknown, opts?: {partial?: boolean}): T;
export declare function toJSONSchema(schema: Schema): Record<string, unknown>;
export declare function requiredKeys(schema: Schema): string[];
export declare function redact<T>(schema: Schema | null | undefined, value: T): T;
export declare function hasSecrets(schema: Schema): boolean;
