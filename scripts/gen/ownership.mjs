// Ownership map (docs/architecture.md section 3): which unit owns which path, computed from the
// layout rules plus the family each spec command and dialog belongs to.
//
// Owner strings: 'I' (integrator), 'F:<app>' or 'F:quill/model|layout|surface' (foundation),
// 'U:<app>/<unit>' (fan-out unit), 'G' (generated, nobody edits), 'spec' (read-only during fan-out),
// 'requests:<from>' (a cross-unit request filed by <from>).
import fs from 'node:fs';
import path from 'node:path';
import {APPS, SPEC_STEM} from './util.mjs';
import {dialogStem} from '../../core/kernel/dialog.mjs';

const APP_ALIASES = {pdf: 'folio'};
const appOf = seg => (APPS.includes(seg) ? seg : APP_ALIASES[seg] ?? null);
const FOUNDATION_FILES = new Set(['address.mjs', 'schema.mjs', 'context.mjs', 'migrate.mjs', 'fixtures.mjs', 'hooks.mjs', 'model.mjs']);
const INTEGRATOR_PREFIXES = ['core/kernel/', 'core/common/', 'src/shell/', 'tests/kernel/', 'tests/bridge/', 'tests/conformance/',
  'electron/', 'scripts/'];

/**
 * @param {{models: Map<string, object|null>, commonIds: Set<string>, dialogCommands?: Map<string, Map<string,string>>,
 *   root?: string, iconOwners?: Record<string, {owner: string}>}} input
 */
export function createOwnership({models, commonIds = new Set(), dialogCommands = new Map(), root = null, iconOwners = {}}) {
  const families = new Map();
  const commandFamily = new Map();
  for (const app of APPS) {
    const set = new Set();
    const byId = new Map();
    const model = models.get(app);
    for (const c of Object.values(model?.commands ?? {})) { set.add(c.family); byId.set(c.id, c.family); }
    if (root) {
      const dir = path.join(root, 'core', app, 'commands');
      try {
        for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
          if (e.name.startsWith('_')) continue;
          if (e.isDirectory()) set.add(e.name);
          else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) set.add(e.name.slice(0, -4));
        }
      } catch { /* no commands yet */ }
    }
    families.set(app, set);
    commandFamily.set(app, byId);
  }

  const commandOwner = (app, id) => {
    if (!id) return null;
    if (commonIds.has(id)) return 'I';
    const fam = commandFamily.get(app)?.get(id);
    if (fam) return `U:${app}/${fam}`;
    const prefix = String(id).split('.')[0];
    return families.get(app)?.has(prefix) ? `U:${app}/${prefix}` : null;
  };

  /** Owner of a dialog: the unit whose family holds its submit command. */
  const dialogOwner = (app, stemOrId) => {
    const model = models.get(app);
    const candidates = [stemOrId, `dialog.${stemOrId}`];
    let submit = null;
    for (const id of candidates) {
      submit = dialogCommands.get(app)?.get(id) ?? model?.dialogs?.[id]?.command ?? null;
      if (submit) break;
    }
    if (!submit) {
      // A dialog no spec command submits: the unit of a command that opens it, else the foundation.
      const opener = Object.values(model?.commands ?? {}).find(c => candidates.includes(c.dialog));
      submit = opener?.id ?? null;
    }
    return commandOwner(app, submit) ?? `F:${app}`;
  };

  const controlOwner = (app, control, tabId) => {
    if (control.command) { const o = commandOwner(app, control.command); if (o) return o; }
    if (control.dialog) return dialogOwner(app, control.dialog);
    return tabId ? `U:${app}/layout-${tabId}` : `F:${app}`;
  };

  /**
   * Owner of the icon a control shows (section 12.4): the unit of the family whose command the
   * control (or the first of its menu items) runs, or whose dialog it opens; a control that runs no
   * command a family owns (a menu of galleries, a command the spec has not listed yet) belongs to the
   * app's 'icons' unit, never to a layout overlay unit (layout units draw no icons).
   */
  const iconOwner = (app, control) => {
    const seen = new Set();
    const walk = c => {
      if (!c || typeof c !== 'object' || seen.has(c)) return null;
      seen.add(c);
      if (c.command) { const o = commandOwner(app, c.command); if (o) return o; }
      if (c.dialog) { const o = dialogOwner(app, c.dialog); if (o !== `F:${app}`) return o; }
      for (const k of c.items ?? []) { const o = walk(k); if (o) return o; }
      return null;
    };
    return walk(control) ?? `U:${app}/icons`;
  };

  /** Longest family that prefixes `name` followed by one of `seps` or the end. */
  const familyPrefix = (app, name, seps) => {
    let best = null;
    for (const f of families.get(app) ?? []) {
      if (name === f || seps.some(s => name.startsWith(f + s))) if (!best || f.length > best.length) best = f;
    }
    return best;
  };

  const extensionOwner = (app, id) => {
    const ext = models.get(app)?.extensions?.find(e => e.id === id);
    return (ext && commandOwner(app, ext.command)) ?? `F:${app}`;
  };

  /** Owner of a repo-relative posix path (inside studio/). */
  function ownerOf(file) {
    const p = file.replace(/\\/g, '/').replace(/^\.\//, '');
    const parts = p.split('/');
    if (p.startsWith('core/generated/') || p.startsWith('src/generated/')) return 'G';
    if (parts[0] === 'docs' && parts[1] === 'spec' && parts.length === 3 && Object.values(SPEC_STEM).includes(parts[2].replace(/\.json$/, ''))) return 'spec';
    if (parts[0] === 'core' && appOf(parts[1])) {
      const app = appOf(parts[1]);
      const sub = parts[2];
      const name = parts[parts.length - 1];
      if (sub === 'commands') {
        if (parts.length === 4 && name.startsWith('_template')) return 'I';
        const fam = parts.length === 4 ? name.replace(/\.test\.mjs$|\.mjs$/, '') : parts[3];
        return `U:${app}/${fam}`;
      }
      if (sub === 'dialogs' && parts.length === 4) return dialogOwner(app, name.replace(/\.mjs$/, ''));
      if (sub === 'formats' && parts.length === 4) {
        const m = /^(.+)-(read|write)\.mjs$/.exec(name);
        return m ? `U:${app}/formats-${m[1]}` : `F:${app}`;
      }
      if (sub === 'lib' && parts.length === 4) {
        const fam = familyPrefix(app, name.replace(/\.mjs$/, ''), ['-']);
        return fam && name !== `${fam}.mjs` ? `U:${app}/${fam}` : `F:${app}`;
      }
      if (app === 'quill' && (sub === 'model' || sub === 'layout')) return `F:quill/${sub}`;
      if (parts.length === 3 && FOUNDATION_FILES.has(sub)) return `F:${app}`;
      return `F:${app}`;
    }
    if (parts[0] === 'src' && parts[1] === 'apps' && appOf(parts[2])) {
      const app = appOf(parts[2]);
      const sub = parts[3];
      const name = parts[parts.length - 1];
      const stem = name.replace(/\.(tsx|ts|css)$/, '');
      if (parts.length === 4) return `F:${app}`;
      if (sub === 'surface') return app === 'quill' ? 'F:quill/surface' : `F:${app}`;
      // The foundation's own view commands (the surface's gestures as commands) belong to the surface.
      if (sub === 'ui-commands' && parts.length === 5 && stem === 'surface') return app === 'quill' ? 'F:quill/surface' : `F:${app}`;
      if (sub === 'ui-commands' && parts.length === 5) return `U:${app}/${stem}`;
      if (sub === 'dialogs' && parts.length === 5) return dialogOwner(app, stem);
      if (sub === 'panes' && parts.length === 5) return `U:${app}/pane-${stem}`;
      if (sub === 'backstage' && parts.length === 5) return `U:${app}/backstage-${stem}`;
      if (sub === 'extensions' && parts.length === 5) return extensionOwner(app, stem);
      return `F:${app}`;
    }
    if (parts[0] === 'docs' && parts[1] === 'spec' && (parts[2] === 'layout' || parts[2] === 'patches') && appOf(parts[3])) {
      const app = appOf(parts[3]);
      const name = parts[parts.length - 1].replace(/\.json$/, '');
      if (parts[2] === 'patches' && parts.length === 5) return `U:${app}/${name}`;
      if (parts[2] === 'layout' && parts.length === 5) return `U:${app}/layout-${name}`;
      if (parts[2] === 'layout' && parts.length === 6 && parts[4] === 'dialogs') return dialogOwner(app, name);
      return 'I';
    }
    if (parts[0] === 'docs' && parts[1] === 'requests' && parts.length === 3) {
      const m = /^(.+?)--(.+?)--(.+)\.md$/.exec(parts[2]);
      return m ? `requests:${m[1]}` : 'I';
    }
    if (parts[0] === 'tests') {
      if (p === 'tests/e2e/harness.mjs') return 'I';
      if (parts[1] === 'e2e' && appOf(parts[2]) && parts.length === 4) {
        const app = appOf(parts[2]);
        const name = parts[3].replace(/\.e2e\.mjs$/, '');
        // The framework's skeleton flow per app is the integrator's; the surface flows are the foundation's.
        if (name === 'skeleton') return 'I';
        if (name === 'surface' || name.startsWith('surface-')) return app === 'quill' ? 'F:quill/surface' : `F:${app}`;
        const fam = familyPrefix(app, name, ['-']);
        return fam ? `U:${app}/${fam}` : `U:${app}/e2e-${name}`;
      }
      if (appOf(parts[1])) {
        const app = appOf(parts[1]);
        if (parts[2] === 'upstream' && parts.length === 4) {
          const fam = familyPrefix(app, parts[3].replace(/\.test\.mjs$/, ''), ['_']);
          return fam ? `U:${app}/${fam}` : `F:${app}`;
        }
        if (parts.length === 3) {
          const fam = familyPrefix(app, parts[2].replace(/\.test\.mjs$/, ''), ['-', '_', '.']);
          return fam ? `U:${app}/${fam}` : `F:${app}`;
        }
        return `F:${app}`;
      }
    }
    if (parts[0] === 'assets' && parts[1] === 'icons' && parts[2] === 'ribbon' && parts.length === 4) {
      const id = parts[3].replace(/(\.32)?\.svg$/, '');
      return iconOwners[id]?.owner ?? 'I';
    }
    if (INTEGRATOR_PREFIXES.some(x => p.startsWith(x))) return 'I';
    return 'I';
  }

  return {ownerOf, commandOwner, dialogOwner, controlOwner, iconOwner, families, dialogStem};
}

/** 'I' | 'integrator' | 'U:grid/data' | 'grid/data' | 'F:quill' | 'F:quill/model' -> canonical unit. */
export function normalizeUnit(unit) {
  const u = String(unit ?? '').trim();
  if (!u) throw new Error('--check-ownership needs a unit (e.g. U:grid/data, F:quill, I)');
  if (u === 'I' || u.toLowerCase() === 'integrator') return 'I';
  if (/^[UF]:/.test(u)) return u.replace(/^U:pdf\//, 'U:folio/').replace(/^F:pdf/, 'F:folio');
  const m = /^([a-z]+)\/(.+)$/.exec(u);
  if (m && appOf(m[1])) return `U:${appOf(m[1])}/${m[2]}`;
  throw new Error(`Unrecognized unit "${u}" (use U:<app>/<unit>, F:<app> or I)`);
}

/** The slug a unit signs cross-unit requests with: U:grid/data -> grid-data, F:quill -> quill-foundation, I -> integrator. */
export const requestSlug = unit => (unit === 'I' ? 'integrator' : unit.startsWith('F:') ? `${unit.slice(2).replace(/\//g, '-')}-foundation`
  : unit.slice(2).replace(/\//g, '-'));

/**
 * Every prefix a unit's request files may start with: the canonical slug (requestSlug) and the
 * forms the foundations and layout units sign with (F:folio -> F-folio, F:quill/surface ->
 * F-quill-surface, U:quill/layout-home -> U-quill-layout-home). A foundation's prefixes cover its
 * sub-units' (F:quill may edit F-quill-surface-- and quill-surface-foundation--).
 */
export function requestSlugs(unit) {
  const out = [requestSlug(unit)];
  if (unit.startsWith('F:')) {
    const parts = unit.slice(2).split('/');
    out.push(`F-${parts.join('-')}`);
    if (parts.length === 1) for (const sub of ['model', 'layout', 'surface']) out.push(`F-${parts[0]}-${sub}`, `${parts[0]}-${sub}-foundation`);
  }
  if (unit.startsWith('U:')) out.push(`U-${unit.slice(2).replace(/\//g, '-')}`);
  return out;
}

export function mayEdit(unit, owner) {
  if (owner === 'G' || owner === 'spec') return false;
  if (owner === unit) return true;
  if (owner.startsWith('requests:')) {
    const from = owner.slice('requests:'.length);
    return requestSlugs(unit).includes(from) || from === unit;
  }
  if (unit.startsWith('F:') && owner.startsWith('F:')) {
    // F:quill may edit F:quill/model, F:quill/layout and F:quill/surface; F:quill/model only its folder.
    return owner.startsWith(unit + '/') || owner === unit;
  }
  return false;
}

/** Files `unit` touches that it does not own. */
export function checkOwnership(ownership, unit, files) {
  const u = normalizeUnit(unit);
  const violations = [];
  for (const f of files) {
    const owner = ownership.ownerOf(f);
    if (!mayEdit(u, owner)) violations.push({file: f, owner});
  }
  return {unit: u, ok: violations.length === 0, violations};
}
