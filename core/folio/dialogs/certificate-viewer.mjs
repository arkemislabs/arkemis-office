// Certificate Viewer: the signer's certificate chain, Summary, Details and Trust (Add to Trusted
// Certificates), and Export….
//
// Translated from printcraft crates/ui-egui/src/tools/sign_ui/panel.rs (CertViewer, CertTab,
// cert_viewer: Summary / Details / Trust, CertAction::Trust and Export, certificate_pem) at
// 3109bb2359759e24ef490e1cdbdba00722b20972. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// The chain is read by sign.certificate when the dialog opens (src/apps/folio/dialogs/
// certificate-viewer.tsx); Acrobat's Revocation tab (OCSP/CRL) is not translated and stays hidden.

import {defineDialog} from '../../kernel/dialog.mjs';

export default defineDialog({
  id: 'dialog.certificate-viewer',
  title: 'Certificate Viewer',
  command: 'sign.certificate',
  init(ctx, args = {}) {
    return {field: args?.field ?? null, level: 0, chain: [], trusted: false};
  },
  validate: () => [],
  buttons: {
    add: (ctx, v) => ({command: 'sign.trust', params: {...(v.field ? {field: v.field} : {}), level: Number(v.level) || 0}}),
    'Export…': (ctx, v) => ({command: 'sign.certificate.export', params: {...(v.field ? {field: v.field} : {}), level: Number(v.level) || 0}}),
  },
  toCommand: v => ({command: 'sign.certificate', params: v.field ? {field: v.field} : {}}),
});
