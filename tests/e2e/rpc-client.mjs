// The end-to-end harness's client for the app's test-only transport (electron/test-rpc-server.cjs).
// main.cjs writes {port, token, pid} to <test data folder>/test-rpc.json when it starts in test mode.
import fs from 'node:fs/promises';
import path from 'node:path';

const CODES = new Set(['invalid_params', 'invalid_address', 'not_found', 'conflict', 'disabled', 'unavailable', 'approval_required',
  'approval_invalid', 'failed', 'too_large', 'timeout']);

function rpcError(code, message, data, status) {
  const error = new Error(message || 'The request failed');
  error.code = CODES.has(code) ? code : 'failed';
  if (data !== undefined) error.data = data;
  if (status !== undefined) error.status = status;
  return error;
}

export class TestRpcClient {
  #base; #token; #seq = 0;
  constructor({port, token, product}) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) throw new Error('Invalid test connection');
    this.#base = `http://127.0.0.1:${port}`;
    this.#token = token;
    this.product = product;
  }

  /** The connection a test-mode app recorded in its data folder, or null while it is not up yet. */
  static async read(data) {
    try { return JSON.parse(await fs.readFile(path.join(data, 'test-rpc.json'), 'utf8')); } catch { return null; }
  }

  /** One /v2/rpc call. With `approve`, an approval_required error asks it and resends with the nonce. */
  async rpc(method, params = {}, {approve} = {}) {
    const once = async p => {
      const response = await fetch(`${this.#base}/v2/rpc`, {method: 'POST', signal: AbortSignal.timeout(60_000),
        headers: {Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({id: ++this.#seq, method, params: p})});
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { throw rpcError('failed', 'The app answered with something that is not JSON', undefined, response.status); }
      if (body?.ok === true) return body.result;
      const e = body?.error ?? {};
      throw rpcError(e.code, e.message, e.data, response.status);
    };
    try { return await once(params); } catch (error) {
      if (error.code !== 'approval_required' || typeof approve !== 'function' || !error.data?.nonce) throw error;
      const request = error.data;
      if (!await approve({tool: method, summary: request.summary, reason: request.reason, risk: request.risk, command: request.command})) throw error;
      return once({...params, approval: {nonce: request.nonce}});
    }
  }
}
