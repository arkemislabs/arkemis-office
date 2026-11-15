// Protect: Protect using password (open password and permissions password, four cipher levels),
// Restrict editing, Remove security, Enter permissions password, Security properties, and opening a
// password-protected PDF.
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972
// (MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/engine/src/commands.rs:374-377     catalog ids, labels, Needs (Security, ProtectedSecurity, Unlock, Document)
//   crates/ui-egui/src/commands.rs:197-219    what each id does: the dialog, "Security will be removed when you save",
//                                             the permissions-password prompt before either when the document is restricted
//   crates/ui-egui/src/dialogs/protect.rs     the dialog (Viewing or Editing, Advanced Options), the edit it makes
//   crates/engine/src/protection.rs           Protection, permission_bits, validate, SecuritySummary, unrestricted
//   crates/engine/src/document.rs:451-500     allows_security_change, can_unlock, security_summary
//   crates/cos/src/document/open.rs           unlock, set_encryption, remove_encryption
//   crates/crypt/src/lib.rs, crates/cos/src/security.rs   lib/crypt.mjs, lib/protect.mjs
//
// The model keeps the plain working copy; `content.security` is what Save encrypts it with (pending
// protection is "written by the next save"), `content.permissions` what a restricted session may do
// (the commands' states read it). Passwords arrive as secret params (journals show them as dots), are
// used to derive keys and are never stored or returned.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/protect.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {pagesOf} from '../lib/comment-geometry.mjs';
import {interactive} from '../lib/page-files.mjs';
import {bytesOf} from '../lib/page-source.mjs';
import * as P from '../lib/protect.mjs';
import {permissionsOf} from '../lib/crypt.mjs';
import {createPdfContent} from '../../pdf-document.mjs';
import {migrateContent} from '../migrate.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '3109bb2359759e24ef490e1cdbdba00722b20972',
  files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/dialogs/protect.rs', 'crates/engine/src/protection.rs',
    'crates/engine/src/document.rs', 'crates/cos/src/document/open.rs', 'crates/cos/src/security.rs', 'crates/crypt/src/lib.rs']};

const noPdf = {enabled: false, reason: 'no PDF open'};
const documentState = ctx => (pagesOf(ctx).length ? {enabled: true} : noPdf);
const secOf = ctx => ctx.doc?.security ?? null;
/** Needs::Security: the document's security may be changed, or a permissions password would allow it. */
function securityState(ctx) {
  if (!pagesOf(ctx).length) return noPdf;
  const sec = secOf(ctx);
  return P.mayChangeSecurity(sec) || P.canUnlock(sec) ? {enabled: true} : {enabled: false, reason: 'enter the permissions password first'};
}
/** Needs::ProtectedSecurity: protected, and the security may be changed (or unlocked). */
function protectedState(ctx) {
  const st = securityState(ctx);
  if (!st.enabled) return st;
  return secOf(ctx) ? st : {enabled: false, reason: "this document isn't password-protected"};
}

const secret = (description) => s.optional(s.secret({max: 1000, description}));

/** The permissions password of a restricted session, from the param or the prompt; throws when it cannot be had. */
async function unlocked(ctx, sec, given) {
  if (!P.canUnlock(sec)) return sec;
  let password = given;
  if (password == null && interactive(ctx) && typeof ctx.host?.openDialog === 'function') {
    const v = await ctx.host.openDialog('prompt.permissions-password', {});
    password = v?.password;
    if (password == null) throw new CommandError('canceled', 'Canceled');
  }
  if (password == null) throw new CommandError('disabled', 'This PDF is restricted: give the permissions password (`unlockPassword`) first.', {path: '/unlockPassword'});
  try { return await P.unlock(sec, password); } catch (e) { throw errorOf(e); }
}

function errorOf(e) {
  if (e instanceof P.PasswordError) return new CommandError('invalid_params', e.message, {path: e.code === 'invalid' ? '/openPassword' : '/password'});
  return e;
}

/** Document Properties > Security: what the document has (printcraft security_summary). */
export function summaryOf(content) {
  const sec = content?.security ?? null;
  if (!sec) return {protected: false, method: 'No Security', owner: true, pending: false, permissions: null};
  const p = permissionsOf(sec.p, false);
  return {protected: true, method: sec.label, owner: !!sec.owner && !sec.pending, pending: !!sec.pending, openPassword: undefined,
    permissions: {printing: p.printHigh ? 'High Resolution' : p.print ? 'Low Resolution (150 dpi)' : 'Not Allowed', changes: p.modify ? 'Allowed' : p.assemble ? 'Inserting, deleting, and rotating pages' : p.fillForms ? (p.annotate ? 'Commenting, filling in form fields, and signing' : 'Filling in form fields and signing') : 'Not Allowed',
      copying: p.copy ? 'Allowed' : 'Not Allowed', accessibility: p.accessibility ? 'Allowed' : 'Not Allowed', encryptMetadata: sec.encryptMetadata}};
}

const protectParams = {
  openPassword: secret('Required to open the document (the user password)'),
  permissionsPassword: secret('Required to change security and lift the restrictions (the owner password)'),
  compatibility: s.optional(s.enum(P.COMPATIBILITY, {description: 'Acrobat X and later (256-bit AES) by default'})),
  encrypt: s.optional(s.enum(['All document contents', 'All document contents except metadata'])),
  printing: s.optional(s.enum(P.PRINTING)),
  changes: s.optional(s.enum(P.CHANGES)),
  copy: s.optional(s.boolean()),
  screenReader: s.optional(s.boolean()),
  unlockPassword: secret('The permissions password of a restricted document, when it is not the one being set'),
};

async function protectRun(ctx, p) {
  const content = ctx.doc;
  const current = await unlocked(ctx, secOf(ctx), p.unlockPassword);
  void current;
  const choices = {openPassword: p.openPassword ?? null, permissionsPassword: p.permissionsPassword ?? null, compatibility: p.compatibility ?? P.COMPATIBILITY[0],
    encryptMetadata: p.encrypt !== 'All document contents except metadata', printing: p.printing ?? P.PRINTING[2], changes: p.changes ?? P.CHANGES[0],
    copy: p.copy ?? false, accessibility: p.screenReader ?? true};
  let rec;
  try { rec = await P.protect(bytesOf(content.sourceBase64), choices); } catch (e) { throw errorOf(e); }
  ctx.change.set(['security'], rec);
  if (content.permissions) ctx.change.delete(['permissions']);
  ctx.setUndoLabel('Protect using password');
  return {protected: true, method: rec.label, pending: true, viewing: choices.openPassword != null, restricted: choices.permissionsPassword != null};
}

export default defineCommands({
  family: 'protect', app: 'folio', upstream: UPSTREAM,
  commands: [
    {
      id: 'protect.password', label: 'Protect using password…', risk: 'edit', needs: 'worker',
      description: 'Protect using password (Acrobat: Protect with password / Password Security): `openPassword` is required to open the document, `permissionsPassword` to change security and lift the limits `printing`, `changes`, `copy` and `screenReader` set (without it nothing is restricted). `compatibility` picks the cipher (AES-256 by default, AES-128, RC4-128, RC4-40: older levels take plain ASCII passwords only); `encrypt` may leave the metadata readable (not with RC4). The two passwords must differ and neither may be empty. The protection is written by the next Save; Remove security undoes it before that.',
      params: s.object(protectParams),
      state: securityState,
      run: protectRun,
    },
    {
      id: 'protect.restrict_editing', label: 'Restrict editing', risk: 'edit', needs: 'worker',
      description: 'Restrict editing (Acrobat Pro): Protect using password with a permissions password only: the document opens for everyone and the `printing`, `changes`, `copy` and `screenReader` limits apply until the permissions password is entered.',
      params: s.object(Object.fromEntries(Object.entries(protectParams).filter(([k]) => k !== 'openPassword'))),
      state: securityState,
      async run(ctx, p) {
        if (p.permissionsPassword == null && interactive(ctx) && typeof ctx.host?.openDialog === 'function') {
          const v = await ctx.host.openDialog('dialog.protect', {for: 'Editing'});
          if (!v) throw new CommandError('canceled', 'Canceled');
          return protectRun(ctx, {permissionsPassword: v.password, compatibility: v.compatibility, encrypt: v.encrypt, printing: v.printing, changes: v.changes, copy: !!v.copy, screenReader: !!v['screen-reader'], unlockPassword: p.unlockPassword});
        }
        if (p.permissionsPassword == null) throw new CommandError('invalid_params', 'Give the permissions password.', {path: '/permissionsPassword'});
        return protectRun(ctx, p);
      },
    },
    {
      id: 'protect.remove', label: 'Remove security', risk: 'edit', needs: 'worker',
      description: 'Remove security: the document is saved without a password or limits ("Security will be removed when you save"). A document opened with its open password only is restricted: the permissions password (`unlockPassword`) is asked first.',
      params: s.object({unlockPassword: protectParams.unlockPassword}),
      state: protectedState,
      async run(ctx, p) {
        const sec = secOf(ctx);
        if (!sec) throw new CommandError('disabled', "This document isn't password-protected");
        await unlocked(ctx, sec, p.unlockPassword);
        ctx.change.delete(['security']);
        if (ctx.doc.permissions) ctx.change.delete(['permissions']);
        ctx.setUndoLabel('Remove security');
        return {removed: true, savedWithout: true};
      },
    },
    {
      id: 'protect.unlock', label: 'Enter permissions password…', risk: 'edit', needs: 'worker',
      description: 'Enter the permissions password of a restricted document: the limits are lifted for this session (the file keeps them). Any other password, the open password included, is refused.',
      params: s.object({password: s.secret({max: 1000, description: 'The permissions (owner) password'})}),
      state: ctx => (pagesOf(ctx).length ? (P.canUnlock(secOf(ctx)) ? {enabled: true} : {enabled: false, reason: 'this document has no limits to lift'}) : noPdf),
      async run(ctx, p) {
        const sec = await unlocked(ctx, secOf(ctx), p.password);
        ctx.change.set(['security'], sec);
        if (ctx.doc.permissions) ctx.change.delete(['permissions']);
        ctx.setUndoLabel('Enter permissions password');
        return {unlocked: true};
      },
    },
    {
      id: 'protect.properties', label: 'Security properties…', risk: 'read', needs: 'worker',
      description: 'Security properties: the security method, whether this session may change it, and what a person without the permissions password may do (printing, changes, copying, text access for screen readers).',
      params: s.object({}),
      state: documentState,
      async run(ctx) { return summaryOf(ctx.doc); },
    },
    {
      id: 'protect.open', label: 'Open a password-protected PDF', risk: 'edit', needs: 'worker',
      description: 'Open the password-protected PDF this document holds: the open password (or the permissions password) decrypts it into the working copy. A wrong password changes nothing.',
      params: s.object({password: s.secret({max: 1000, description: 'The open or permissions password'})}),
      state: ctx => (ctx.doc?.locked ? {enabled: true} : {enabled: false, reason: 'this document is not waiting for a password'}),
      async run(ctx, p) {
        const content = ctx.doc;
        let opened;
        try { opened = await P.openPdf(bytesOf(content.locked.sourceBase64), p.password); } catch (e) { throw errorOf(e); }
        const base = await createPdfContent(opened.bytes, content.sourceName);
        const next = await migrateContent(base);
        for (const [k, v] of Object.entries(next)) ctx.change.set([k], v);
        if (opened.security) {
          ctx.change.set(['security'], opened.security);
          const permissions = P.permissionsOfRecord(opened.security);
          if (permissions) ctx.change.set(['permissions'], permissions);
        }
        ctx.change.delete(['locked']);
        ctx.setUndoLabel('Open');
        return {opened: true, owner: opened.security?.owner ?? true};
      },
    },
  ],
});
