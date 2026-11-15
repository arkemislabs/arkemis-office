// Renderer bundles besides src/main.tsx, shared by scripts/build.mjs and tests/e2e/harness.mjs
// devRenderer. A worker the renderer starts with `new Worker('./<out>', {type: 'module'})` (served
// from studio://app/) is bundled on its own, because esbuild does not follow
// `new Worker(new URL(...))`. An entry is built only when its source exists, so the owner adds the
// file and the build picks it up (design note F-grid--integrator--calc-worker-entry).
export const WORKER_ENTRIES = Object.freeze([
  {entry: 'src/workers/grid-calc.ts', out: 'grid-calc.js'},
  {entry: 'src/workers/folio-text.ts', out: 'folio-text.js'},
  {entry: 'src/workers/spelling.ts', out: 'spelling.js'},
]);
