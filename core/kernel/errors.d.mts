// Types for core/kernel/errors.mjs (docs/architecture.md section 15.6).
export type ErrorCode = 'invalid_params' | 'invalid_address' | 'not_found' | 'conflict' | 'disabled' | 'unavailable'
  | 'approval_required' | 'approval_invalid' | 'failed' | 'too_large' | 'timeout';
export declare const ERROR_CODES: readonly ErrorCode[];
export declare const HTTP_STATUS: Readonly<Record<ErrorCode, number>>;
export declare class CommandError extends Error {
  constructor(code: ErrorCode, message: string, data?: unknown);
  code: ErrorCode;
  data?: unknown;
  readonly status: number;
  toJSON(): {code: ErrorCode; message: string; data?: unknown};
}
export declare function isCommandError(e: unknown): e is CommandError;
export declare function toCommandError(e: unknown): CommandError;
export declare function invalidParams(message: string, data?: unknown): CommandError;
export declare function notFound(message: string, data?: unknown): CommandError;
export declare function disabled(reason: string, data?: unknown): CommandError;
export declare function unavailable(message: string, data?: unknown): CommandError;
export declare function failed(message: string, data?: unknown): CommandError;
