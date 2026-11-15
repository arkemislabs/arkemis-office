// Command error codes shared by the kernel and the automation layer
// (docs/architecture.md section 15.6). No DOM, no Node built-ins.

export const ERROR_CODES = Object.freeze([
  'invalid_params',
  'invalid_address',
  'not_found',
  'conflict',
  'disabled',
  'unavailable',
  'approval_required',
  'approval_invalid',
  'failed',
  'too_large',
  'timeout',
]);

/** HTTP status the bridge answers with for each code. */
export const HTTP_STATUS = Object.freeze({
  invalid_params: 400,
  invalid_address: 400,
  not_found: 404,
  conflict: 409,
  disabled: 422,
  unavailable: 503,
  approval_required: 428,
  approval_invalid: 403,
  failed: 500,
  too_large: 413,
  timeout: 504,
});

const codes = new Set(ERROR_CODES);

export class CommandError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message
   * @param {unknown} [data]
   */
  constructor(code, message, data) {
    super(message);
    if (!codes.has(code)) throw new TypeError(`Unknown command error code: ${code}`);
    this.name = 'CommandError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
  get status() { return HTTP_STATUS[this.code]; }
  toJSON() {
    return this.data === undefined
      ? {code: this.code, message: this.message}
      : {code: this.code, message: this.message, data: this.data};
  }
}

export const isCommandError = e => e instanceof CommandError
  || (!!e && typeof e === 'object' && typeof e.code === 'string' && codes.has(e.code) && typeof e.message === 'string');

/** Wrap anything thrown by a command into a CommandError (code `failed` unless it already has one). */
export function toCommandError(e) {
  if (e instanceof CommandError) return e;
  if (isCommandError(e)) return new CommandError(e.code, e.message, e.data);
  const message = e instanceof Error ? e.message : String(e);
  return new CommandError('failed', message || 'The command failed');
}

export const invalidParams = (message, data) => new CommandError('invalid_params', message, data);
export const notFound = (message, data) => new CommandError('not_found', message, data);
export const disabled = (reason, data) => new CommandError('disabled', reason, data);
export const unavailable = (message, data) => new CommandError('unavailable', message, data);
export const failed = (message, data) => new CommandError('failed', message, data);
