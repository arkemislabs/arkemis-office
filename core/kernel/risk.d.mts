// Types for core/kernel/risk.mjs (docs/architecture.md section 15.7).
import type {Risk} from './command.mjs';

export declare const RISKS: readonly Risk[];
export declare const APPROVAL_TTL_MS: number;
export declare function isRisk(r: unknown): r is Risk;
export declare function riskRank(r: string): number;
export declare function maxRisk(a: Risk, b: Risk): Risk;
export declare function needsApproval(risk: Risk, origin: string): boolean;
export declare function approvalReason(risk: Risk): string;
export declare function canonicalJSON(value: unknown): string;
export declare function sha256Hex(text: string): Promise<string>;
export declare function randomToken(bytes?: number): string;
export interface ApprovalRequest { nonce: string; summary: string; reason: string; risk: Risk; command: string; expires: string }
export interface ApprovalBinding { docId: string | null; command: string; params: unknown; version: number | null }
export declare function approvalBinding(b: ApprovalBinding): Promise<string>;
export declare class ApprovalStore {
  constructor(opts?: {now?: () => number; ttl?: number; limit?: number});
  issue(b: ApprovalBinding & {risk: Risk; summary: string}): Promise<ApprovalRequest>;
  consume(nonce: string, b: ApprovalBinding): Promise<void>;
  prune(): void;
}
