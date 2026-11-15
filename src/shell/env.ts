// Build-time flags (scripts/build.mjs `define`s each to "0" or "1"; esbuild drops the dead branch).
//   ARKEMIS_SHOW_PENDING  development: pending (untranslated) controls render hatched and disabled
//   ARKEMIS_DIAGNOSTICS   development: the diagnostics panel and test hooks are compiled in
//   ARKEMIS_NEW_HOST      development: every app renders <AppHost> even before its manifest is ready
export const SHOW_PENDING = process.env.ARKEMIS_SHOW_PENDING === '1';
export const DIAGNOSTICS = process.env.ARKEMIS_DIAGNOSTICS === '1';
export const NEW_HOST = process.env.ARKEMIS_NEW_HOST === '1';
/** Test hooks (window.__arkemisRpc) exist only in development builds, never in production. */
export const DEV_HOOKS = SHOW_PENDING || DIAGNOSTICS || NEW_HOST;

export type Platform = 'mac' | 'win' | 'linux';
export function platform(): Platform {
  const p = typeof navigator === 'undefined' ? '' : String((navigator as any).userAgentData?.platform ?? navigator.platform ?? '');
  return /mac/i.test(p) ? 'mac' : /linux/i.test(p) ? 'linux' : 'win';
}
