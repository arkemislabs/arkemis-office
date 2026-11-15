// The folio text worker: reads a page's content, groups its paragraphs and rewrites one, off the window's thread (core/folio/lib/text-ops.mjs).
// Started by core/folio/lib/text-client.mjs as new Worker('./folio-text.js', {type: 'module'}); bundled by scripts/build.mjs from
// scripts/renderer-entries.mjs. The document is only ever read as data: nothing in it is executed.
import {OPS} from '../../core/folio/lib/text-ops.mjs';

const scope: any = self;

scope.onmessage = async (e: MessageEvent) => {
  const {id, op, args} = e.data ?? {};
  try {
    const run = (OPS as Record<string, (a: unknown) => Promise<any>>)[op];
    if (!run) throw Object.assign(new Error(`unknown text operation ${op}`), {code: 'invalid_params'});
    const result = await run(args);
    const transfer = result?.bytes instanceof Uint8Array ? [result.bytes.buffer] : [];
    scope.postMessage({id, ok: true, result}, transfer);
  } catch (err: any) {
    scope.postMessage({id, ok: false, error: {message: String(err?.message ?? err), code: err?.code ?? 'invalid_params', path: err?.path}});
  }
};
