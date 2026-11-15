// Security properties (Document Properties > Security): the security method, whether this session
// may change it, and what a person without the permissions password may do. Read only.
// Translated from printcraft crates/engine/src/protection.rs (SecuritySummary) and
// crates/engine/src/document.rs (security_summary) at 3109bb2359759e24ef490e1cdbdba00722b20972.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {defineDialog} from '../../kernel/dialog.mjs';
import {summaryOf} from '../commands/protect.mjs';

export default defineDialog({
  id: 'dialog.security-properties',
  title: 'Security Properties',
  init(ctx) {
    const sm = summaryOf(ctx.doc);
    return {method: sm.method, status: !sm.protected ? 'This document has no security.' : sm.pending ? 'Set in this session: written when you save.' : sm.owner ? 'Opened with the permissions password: no limits apply to you.' : 'Opened with the open password: the limits below apply.',
      printing: sm.permissions?.printing ?? 'Allowed', changes: sm.permissions?.changes ?? 'Allowed', copying: sm.permissions?.copying ?? 'Allowed', accessibility: sm.permissions?.accessibility ?? 'Allowed',
      metadata: sm.permissions ? (sm.permissions.encryptMetadata ? 'Encrypted' : 'Not encrypted') : sm.protected ? 'Encrypted' : 'Not encrypted'};
  },
  validate: () => [],
  toCommand: () => ({command: 'protect.properties', params: {}}),
});
