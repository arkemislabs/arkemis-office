// Calling the text operations (text-ops.mjs): in the folio text worker when the renderer can start one, else in the calling thread (in slices).
//
// The worker is src/workers/folio-text.ts, bundled on its own (scripts/renderer-entries.mjs) and started as new Worker('./folio-text.js', {type: 'module'}).
// A worker that can't start, or dies, is given up for the rest of the session and the call is made in the thread; an operation that fails because of the
// document (a TextError) is not retried. `via` in the answer says which ran. No Node built-ins.

import {OPS} from './text-ops.mjs';
import {TextError} from './text-interp.mjs';

let worker = null;
let gaveUp = false;
let seq = 0;
const waiting = new Map();

function giveUp(reason) {
  gaveUp = true;
  try { worker?.terminate(); } catch { /* already gone */ }
  worker = null;
  for (const [, w] of waiting) w.reject(Object.assign(new Error(reason), {workerFailed: true}));
  waiting.clear();
}

function start() {
  if (gaveUp || worker) return worker;
  if (typeof Worker !== 'function' || typeof document === 'undefined') { gaveUp = true; return null; }
  try {
    const w = new Worker('./folio-text.js', {type: 'module'});
    w.onmessage = e => {
      const {id, ok, result, error} = e.data ?? {};
      const entry = waiting.get(id);
      if (!entry) return;
      waiting.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(Object.assign(new TextError(error.message, error.code), {path: error.path}));
    };
    w.onerror = e => giveUp(`the text worker failed: ${e.message ?? 'unknown error'}`);
    w.onmessageerror = () => giveUp('the text worker sent something unreadable');
    worker = w;
  } catch { gaveUp = true; worker = null; }
  return worker;
}

/** Run operation `op` with `args`: {result..., via: 'worker' | 'thread'}. */
export async function callText(op, args) {
  const w = start();
  if (w) {
    try {
      const id = ++seq;
      const answer = await new Promise((resolve, reject) => { waiting.set(id, {resolve, reject}); w.postMessage({id, op, args}); });
      return {...answer, via: 'worker'};
    } catch (e) {
      if (!e.workerFailed) throw e;
    }
  }
  return {...(await OPS[op](args)), via: 'thread'};
}

/** For tests: forget a worker that was given up. */
export function resetTextClient() { gaveUp = false; worker = null; waiting.clear(); }
