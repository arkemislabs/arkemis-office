// Opening an older document in the new host (docs/architecture.md sections 4.1 and 18): a schema-1
// file is converted with its app's core/<app>/migrate.mjs `migrateFile` when a host opens it, the
// way Word converts an older format in memory when it opens it. PDF documents keep `schema: 1` and
// have their content upgraded in place (core/folio/migrate.mjs `needsMigration`: content.folio !== 2).
// Both hosts use this: the renderer's EngineProvider and the headless host. No app knowledge here
// beyond the foundation's exports. Pure: no DOM, no Node built-ins.

/** Does `file` need its app's migration before a new-host session opens it? */
export function needsMigration(foundation, file) {
  const m = foundation?.migrate;
  if (!m || typeof m.migrateFile !== 'function' || !file || typeof file !== 'object') return false;
  if (typeof m.needsMigration === 'function') return !!m.needsMigration(file.content);
  return file.schema === 1;
}

/**
 * The file a new-host session opens: migrated when it needs it.
 * @returns {Promise<{file: object, migrated: boolean, from: number|null, error: string|null}>}
 *   `error`: the migration failed and the original file is returned (the surface shows its notice).
 */
export async function migrateOnOpen(foundation, file) {
  if (!needsMigration(foundation, file)) return {file, migrated: false, from: null, error: null};
  try {
    const next = await foundation.migrate.migrateFile(file);
    if (!next || typeof next !== 'object' || next === file) return {file, migrated: false, from: null, error: null};
    return {file: next, migrated: true, from: typeof file.schema === 'number' ? file.schema : null, error: null};
  } catch (e) {
    return {file, migrated: false, from: null, error: e instanceof Error ? e.message : String(e)};
  }
}

/**
 * Is `next` the migrated form of `prev` (schema 1 -> 2, or a PDF's content upgraded)? Used where a
 * write of a migration must not count as the person's change (the file binding's saved state).
 */
export function isUpgrade(prev, next) {
  if (!prev || !next || prev.id !== next.id || prev.kind !== next.kind) return false;
  if (prev.schema === 1 && next.schema === 2) return true;
  return prev.kind === 'folio' && prev.content?.folio !== 2 && next.content?.folio === 2;
}
