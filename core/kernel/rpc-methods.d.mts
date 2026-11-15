// Types for core/kernel/rpc-methods.mjs (docs/bridge-protocol.md section 3.2).
import type {Session} from './session.mjs';
import type {Schema} from './schema.mjs';

export declare const DOC_ID_PATTERN: string;
export declare const READ_LIMIT_BYTES: number;
export declare const METHOD_PARAMS: Readonly<Record<RpcMethod, Schema>>;
export declare const RPC_METHODS: readonly RpcMethod[];

export type RpcMethod =
  | 'engine.commands' | 'engine.execute' | 'engine.batch'
  | 'document.inspect' | 'document.read' | 'document.find' | 'document.anchor'
  | 'selection.get' | 'selection.set';

export interface RpcMethods {
  readonly methods: readonly RpcMethod[];
  has(method: string): boolean;
  /** Validates params, runs the method with origin 'bridge'. Rejects with a CommandError. */
  call(method: string, params?: unknown): Promise<unknown>;
}

export declare function createRpcMethods(
  session: Session,
  opts?: {manifest?: {commands?: unknown[]}; viewAvailable?: boolean},
): RpcMethods;
