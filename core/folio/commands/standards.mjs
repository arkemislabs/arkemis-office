// Standards and Print production: Save as PDF/A (verify, convert, remove the declared id), the PDF/UA check, the PDF/X check, Preflight with its profiles, Output
// Preview, and the Standards panel.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/dialogs/standards_ui.rs   the PDF/A dialog: Declared conformance, Output intent, Conformance level (PDF/A-2b, PDF/A-3b), Verify, Save as PDF/A
//                                                ("The document now conforms to {level}; save it to keep the changes" only after verify finds nothing, else "Fixed what could
//                                                be fixed; {n} problems remain"), the problems with their clause and "not fixable here"
//   crates/preflight                             lib/standards.mjs
// Not checked against upstream (it has none of these): the PDF/UA check, the PDF/X check, Preflight's profiles other than the two PDF/A ones, Output Preview. A PDF/A
// verify that finds nothing says which kinds of check it made and which it did not; it never says the document conforms. Save as PDF/UA and Save as PDF/X stay hidden:
// nothing here can make a document conform to either, only check some of their points.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/standards.test.mjs and tests/folio/standards-commands.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {pagesOf} from '../lib/comment-geometry.mjs';
import {documentOpen, modification} from '../lib/edit-needs.mjs';
import {editable, commit} from '../lib/page-source.mjs';
import {writeFolioPdf} from '../model/pdf-write.mjs';
import {mayChangeSecurity} from '../lib/protect.mjs';
import {PDFDocument} from 'pdf-lib';
import * as S from '../lib/standards.mjs';
import * as A from '../lib/a11y.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/dialogs/standards_ui.rs', 'crates/preflight/src/lib.rs', 'crates/preflight/src/xmp.rs', 'crates/preflight/src/icc.rs']};
const noPdf = {enabled: false, reason: 'no PDF open'};
const documentState = ctx => (pagesOf(ctx).length ? {enabled: true} : noPdf);
const LEVEL_NAMES = ['PDF/A-2b', 'PDF/A-3b'];
const levelParam = s.optional(s.enum(LEVEL_NAMES, {description: 'PDF/A-2b by default'}));
const levelOfParam = p => S.levelOf(p.level ?? 'PDF/A-2b') ?? 'A2b';

/** The document as the checks read it: the model written out, as a pdf-lib document. */
async function checkDoc(ctx) { return PDFDocument.load(await writeFolioPdf(ctx.doc), {updateMetadata: false, ignoreEncryption: true}); }

/** The PDF/A result: the problems, and what was and was not checked. A pass never says "conforms". */
function pdfaResult(doc, level, ctx) {
  const issues = S.verify(doc, level, {encrypted: !!ctx.doc?.security});
  const label = S.LEVELS[level].label;
  const decl = S.declared(doc);
  return {level: label, declared: S.declaredNames(decl), outputIntents: decl.outputIntents, issues, ok: issues.length === 0, checked: S.PDFA_CHECKED, notVerified: S.PDFA_NOT_VERIFIED,
    message: issues.length === 0 ? `No problems found in the ${S.PDFA_CHECKED.length} checks listed: this is not a statement that the document conforms to ${label}, because ${S.PDFA_NOT_VERIFIED.length} kinds of check are not made.`
      : issues.length === 1 ? '1 problem found' : `${issues.length} problems found`};
}

const toggle = (id, label, panel, description) => ({
  id, label, risk: 'read', effect: 'view', undo: 'none', description,
  params: s.object({open: s.optional(s.boolean())}),
  state: ctx => ({...documentState(ctx), checked: ctx.view?.rightPanel === panel}),
  run(ctx, p) {
    const open = p.open ?? ctx.view?.rightPanel !== panel;
    ctx.setView({rightPanel: open ? panel : null, ...(open ? {panel: null} : {})});
    return {panel: open ? panel : null};
  },
});

const items = result => result.items.map(i => ({status: i.status, label: i.label, clause: i.clause, details: i.details}));

/** Preflight profiles: each is a list of results with what was not checked. */
export const PROFILES = [
  {id: 'pdfa-2b', label: 'PDF/A-2b compliance (verify)', note: 'The PDF/A checks of printcraft crates/preflight.'},
  {id: 'pdfa-3b', label: 'PDF/A-3b compliance (verify)', note: 'The PDF/A checks of printcraft crates/preflight.'},
  {id: 'pdfua-1', label: 'PDF/UA-1 (partial check)', note: 'The points of ISO 14289-1 the Accessibility Checker rules cover. Not checked against upstream.'},
  {id: 'pdfx-4', label: 'PDF/X-4 (partial check)', note: 'The points of ISO 15930-7 that can be read from the objects. Not checked against upstream.'},
  {id: 'fonts', label: 'Fonts that are not embedded', note: 'Every font the document uses and whether it is embedded.'},
  {id: 'colour', label: 'Colour and inks', note: 'The colour spaces, inks and warnings of Output Preview.'},
];

function fontRows(doc) {
  const rows = [];
  const seen = new Set();
  for (const issue of S.verify(doc, 'A2b')) if (/^The font |^A font isn't embedded/.test(issue.message)) { if (!seen.has(issue.message)) { seen.add(issue.message); rows.push(issue.message); } }
  return rows;
}

async function preflight(ctx, id) {
  const doc = await checkDoc(ctx);
  const p = PROFILES.find(x => x.id === id);
  if (id === 'pdfa-2b' || id === 'pdfa-3b') {
    const r = pdfaResult(doc, id === 'pdfa-2b' ? 'A2b' : 'A3b', ctx);
    return {profile: id, label: p.label, summary: r.message, ok: r.ok, items: r.issues.map(i => ({status: 'failed', label: i.message, clause: `ISO 19005 ${i.clause}`, details: [`${i.page !== null ? `Page ${i.page + 1}. ` : ''}${i.fixable ? 'Save as PDF/A can fix this.' : 'Not fixable here.'}`]})),
      checked: r.checked, notVerified: r.notVerified, fixable: r.issues.some(i => i.fixable) || r.issues.length > 0};
  }
  if (id === 'pdfua-1') {
    const rep = A.check(doc, {rules: A.defaultRules(), accessibilityAllowed: null});
    const r = S.pdfuaCheck(doc, rep);
    const failed = r.items.filter(i => i.status === 'failed').length;
    return {profile: id, label: p.label, summary: failed ? `${failed} of ${r.items.length} points failed` : `No problems found in the ${r.items.length} points checked: this is not a statement that the document conforms to PDF/UA-1.`, ok: failed === 0, items: items(r), notVerified: r.notVerified};
  }
  if (id === 'pdfx-4') {
    const r = S.pdfxCheck(doc, {encrypted: !!ctx.doc?.security});
    const failed = r.items.filter(i => i.status === 'failed').length;
    return {profile: id, label: p.label, summary: failed ? `${failed} of ${r.items.length} points failed` : `No problems found in the ${r.items.length} points checked: this is not a statement that the document conforms to PDF/X-4.`, ok: failed === 0, items: items(r), notVerified: r.notVerified};
  }
  if (id === 'fonts') {
    const rows = fontRows(doc);
    return {profile: id, label: p.label, summary: rows.length ? `${rows.length} font${rows.length === 1 ? ' is' : 's are'} not embedded` : 'Every font that is not a Type 3 font is embedded', ok: rows.length === 0, items: rows.map(m => ({status: 'failed', label: m, details: []})), notVerified: []};
  }
  const o = S.outputPreview(doc);
  return {profile: id, label: p.label, summary: o.warnings.length ? `${o.warnings.length} warnings` : 'No colour warnings', ok: o.warnings.length === 0,
    items: o.warnings.map(w => ({status: 'failed', label: w.message, details: w.page !== null ? [`Page ${w.page + 1}`] : []})), notVerified: ['The page is not simulated: no ink limit or overprint preview']};
}

export default defineCommands({
  family: 'standards',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'standards.read', label: 'Standards', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'The standards the document declares (PDF/A and PDF/UA from its XMP metadata) and its output intents; this says what the file claims, not whether it conforms.',
      params: s.object({}), state: documentState,
      async run(ctx) { const d = S.declared(await checkDoc(ctx)); return {declared: S.declaredNames(d), pdfa: d.pdfa, pdfua: d.pdfua, outputIntents: d.outputIntents}; },
    },
    {
      id: 'standards.pdfa.verify', label: 'Verify PDF/A', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Verify the document against PDF/A-2b or PDF/A-3b (`level`): the problems, each with its ISO 19005 clause and whether Save as PDF/A can fix it. A document with no problems has passed only the checks listed in `checked`; `notVerified` lists what is not checked, and nothing here says the document conforms.',
      params: s.object({level: levelParam}), state: documentOpen,
      async run(ctx, p) { return pdfaResult(await checkDoc(ctx), levelOfParam(p), ctx); },
    },
    {
      id: 'standards.pdfa.convert', label: 'Save as PDF/A', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Save as PDF/A-2b or PDF/A-3b (`level`): fixes what can be fixed without changing how the pages look (the XMP identification, an sRGB output intent when there is no CMYK, forbidden and additional actions, multimedia annotations, annotation flags, image interpolation and alternates, NeedAppearances, security) and returns what remains (fonts that are not embedded cannot be fixed here). It is one undo step; save the document to keep it. Whether anything remains is the verify of the converted file: never a claim of conformance.',
      params: s.object({level: levelParam}), state: modification,
      async run(ctx, p) {
        const level = levelOfParam(p);
        const {doc, content} = await editable(ctx.doc, []);
        const r = S.convert(doc, level);
        const sec = ctx.doc.security;
        if (sec) {
          if (mayChangeSecurity(sec)) { ctx.change.delete(['security']); if (ctx.doc.permissions) ctx.change.delete(['permissions']); r.fixed.unshift('Removed security (it is removed when you save)'); r.remaining = r.remaining.filter(i => i.message !== 'The document is encrypted'); }
          else r.remaining.push({clause: '6.1.3', message: 'The document is encrypted', page: null, fixable: false});
        }
        await commit(ctx, doc, content);
        ctx.setUndoLabel('Save as PDF/A');
        const label = S.LEVELS[level].label;
        const left = r.remaining.length;
        return {level: label, fixed: r.fixed, remaining: r.remaining, notVerified: S.PDFA_NOT_VERIFIED,
          message: left === 0 ? `Fixed what could be fixed and the ${S.PDFA_CHECKED.length} checks found no problem; save it to keep the changes. This is not a statement that it conforms to ${label}.` : left === 1 ? 'Fixed what could be fixed; 1 problem remains' : `Fixed what could be fixed; ${left} problems remain`};
      },
    },
    {
      id: 'standards.pdfa.remove_id', label: 'Remove PDF/A identification', risk: 'edit', undo: 'auto', needs: 'worker',
      description: 'Remove the PDF/A identification from the XMP metadata (the document no longer claims to be PDF/A); the rest of the metadata stays.',
      params: s.object({}), state: modification,
      async run(ctx) {
        const {doc, content} = await editable(ctx.doc, []);
        if (!S.removeStandardId(doc, 'pdfa')) throw new CommandError('failed', 'The document does not declare PDF/A');
        await commit(ctx, doc, content);
        ctx.setUndoLabel('Remove PDF/A identification');
        return {removed: true};
      },
    },
    {
      id: 'standards.pdfua.check', label: 'Check PDF/UA', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Check the points of PDF/UA-1 (ISO 14289-1) that the Accessibility Checker rules and the XMP identification cover: each point is Passed, Failed or Not checked, and `notVerified` lists what no check here can decide (reading order, whether alternate text is right, colour contrast). It does not make a document PDF/UA and never says it is one. Not checked against upstream.',
      params: s.object({}), state: documentOpen,
      async run(ctx) {
        const doc = await checkDoc(ctx);
        const rep = A.check(doc, {rules: A.defaultRules(), accessibilityAllowed: null});
        const r = S.pdfuaCheck(doc, rep);
        const failed = r.items.filter(i => i.status === 'failed').length;
        return {items: items(r), failed, notVerified: r.notVerified, message: failed ? `${failed} of ${r.items.length} points failed` : `No problems found in the ${r.items.length} points checked: this is not a statement that the document conforms to PDF/UA-1.`};
      },
    },
    {
      id: 'standards.pdfx.check', label: 'Check PDF/X', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Check the points of PDF/X-4 (ISO 15930-7) that can be read from the objects: the declared version, the output intent, the boxes, the fonts, the actions and security. It cannot convert a document to PDF/X and never says it conforms. Not checked against upstream.',
      params: s.object({}), state: documentOpen,
      async run(ctx) {
        const r = S.pdfxCheck(await checkDoc(ctx), {encrypted: !!ctx.doc.security});
        const failed = r.items.filter(i => i.status === 'failed').length;
        return {items: items(r), failed, notVerified: r.notVerified, message: failed ? `${failed} of ${r.items.length} points failed` : `No problems found in the ${r.items.length} points checked: this is not a statement that the document conforms to PDF/X-4.`};
      },
    },
    {
      id: 'standards.preflight.profiles', label: 'Preflight profiles', risk: 'read', effect: 'view', undo: 'none', needs: 'model',
      description: 'The profiles Preflight can analyze a document with.',
      params: s.object({}), state: documentState,
      run() { return {profiles: PROFILES}; },
    },
    {
      id: 'standards.preflight', label: 'Preflight', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Preflight: analyze the document with a `profile` (from standards.preflight.profiles: pdfa-2b, pdfa-3b, pdfua-1, pdfx-4, fonts, colour) and list what fails, what the profile did not check (`notVerified`) and whether Save as PDF/A can fix it. A profile with no failures has passed only its own checks. Not checked against upstream except the two PDF/A profiles.',
      params: s.object({profile: s.optional(s.enum(PROFILES.map(x => x.id)))}), state: documentOpen,
      async run(ctx, p) { return preflight(ctx, p.profile ?? 'pdfa-2b'); },
    },
    {
      id: 'standards.output_preview', label: 'Output preview', risk: 'read', effect: 'view', undo: 'none', needs: 'worker',
      description: 'Output Preview: the simulation profile (the output intent), the colour spaces in use with the pages that use them, the inks they print on (process and spot) and the warnings a printer would raise (device colour without an output intent, transparency, overprint, spot colours). The page itself is not simulated. Not checked against upstream.',
      params: s.object({}), state: documentOpen,
      async run(ctx) { return S.outputPreview(await checkDoc(ctx)); },
    },
    toggle('standards.panel', 'Standards', 'standards', 'Show or hide the Standards panel in the right rail (the standards the document declares, with Verify PDF/A and the PDF/UA check); default: toggle.'),
  ],
});
void A;
