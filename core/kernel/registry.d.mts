// Types for core/kernel/registry.mjs.
import type {CommandFamily, RegisteredCommand} from './command.mjs';

export interface Registry {
  readonly app: string | null;
  readonly size: number;
  get(id: string): RegisteredCommand | null;
  has(id: string): boolean;
  ids(): string[];
  families(): {family: string; app: CommandFamily['app']; upstream: CommandFamily['upstream']; source: string | null; commands: RegisteredCommand[]}[];
  list(opts?: {search?: string; family?: string}): RegisteredCommand[];
}
export declare function findDuplicates(modules: CommandFamily[], sources?: string[]): {id: string; files: string[]}[];
export declare function buildRegistry(modules: CommandFamily[], opts?: {app?: string; sources?: string[]}): Registry;
