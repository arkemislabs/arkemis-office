// Risk levels, approval nonces and summaries (docs/architecture.md sections 5.1 and 15.7).
// No DOM, no Node built-ins: hashing and randomness use Web Crypto (globalThis.crypto), which
// both Electron's renderer and Node provide.

import {CommandError} from './errors.mjs';

export const RISKS = Object.freeze(['read', 'edit', 'destructive', 'irreversible']);
const RANK = Object.freeze({read: 0, edit: 1, destructive: 2, irreversible: 3});
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

export const isRisk = r => Object.hasOwn(RANK, r);
export const riskRank = r => RANK[r] ?? -1;
export const maxRisk = (a, b) => (riskRank(a) >= riskRank(b) ? a : b);
/** Whether a request needs the person's approval: destructive and irreversible steps asked for over the bridge. */
export const needsApproval = (risk, origin) => origin === 'bridge' && riskRank(risk) >= RANK.destructive;
export const approvalReason = risk => (risk === 'irreversible'
  ? 'This cannot be undone, or others will see it.'
  : 'This loses data outside the undo history.');

/** JSON with sorted object keys, so equal params give equal strings. */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

const crypto = () => {
  const c = globalThis.crypto;
  if (!c?.subtle || !c.getRandomValues) throw new CommandError('unavailable', 'Web Crypto is not available in this environment');
  return c;
};
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text) {
  return hex(await crypto().subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export function randomToken(bytes = 16) {
  const b = new Uint8Array(bytes);
  crypto().getRandomValues(b);
  return hex(b);
}

/** The binding a nonce is issued for: sha256(doc, command, canonical params, version). */
export const approvalBinding = ({docId, command, params, version}) =>
  sha256Hex(canonicalJSON({doc: docId ?? null, command, params: params ?? {}, version: version ?? null}));

/**
 * Single-use approval nonces. `issue` returns the `approval_required` data; `consume` verifies a
 * resend and burns the nonce whatever the outcome of the command.
 */
export class ApprovalStore {
  constructor({now = () => Date.now(), ttl = APPROVAL_TTL_MS, limit = 1000} = {}) {
    this.now = now;
    this.ttl = ttl;
    this.limit = limit;
    /** @type {Map<string, {binding: string, expires: number}>} */
    this.pending = new Map();
  }
  prune() {
    const t = this.now();
    for (const [n, e] of this.pending) if (e.expires <= t) this.pending.delete(n);
    while (this.pending.size >= this.limit) this.pending.delete(this.pending.keys().next().value);
  }
  async issue({docId, command, params, version, risk, summary}) {
    this.prune();
    const nonce = randomToken(16);
    const expires = this.now() + this.ttl;
    this.pending.set(nonce, {binding: await approvalBinding({docId, command, params, version}), expires});
    return {nonce, summary, reason: approvalReason(risk), risk, command, expires: new Date(expires).toISOString()};
  }
  /** Throws approval_invalid unless the nonce was issued for exactly this request and is unexpired. */
  async consume(nonce, {docId, command, params, version}) {
    if (typeof nonce !== 'string' || !this.pending.has(nonce)) throw new CommandError('approval_invalid', 'The approval is unknown, used or expired');
    const e = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (e.expires <= this.now()) throw new CommandError('approval_invalid', 'The approval has expired');
    if (e.binding !== await approvalBinding({docId, command, params, version})) {
      throw new CommandError('approval_invalid', 'The approval was given for a different request');
    }
  }
}
