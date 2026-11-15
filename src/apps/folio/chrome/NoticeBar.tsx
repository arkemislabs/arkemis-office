// The notice bar over the pages (printcraft crates/ui-egui/src/canvas/bars.rs `notices`, `notice_bar` at 8f16855): an icon and
// one message on the left, its buttons on the right (Dismiss, Highlight fields, Security settings, Unlock…, Don't show
// again). What it says is core/folio/lib/notice.mjs; every button is a spec control of the Notice bars tab, so the
// buttons run the same commands the bridge does.

import type {RibbonGroup} from '../../../shell/model';
import {isControl} from '../../../shell/model';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick, useShellState} from '../../../shell/engine/useCommand';
import {RibbonControl} from '../../../shell/ribbon/controls';
import {Icon} from '../../../shell/icons/Icon';
import {noticeOf} from '../../../../core/folio/lib/notice.mjs';
import './tools-chrome.css';

const GROUP = 'notice-bars/notices';

export default function NoticeBar() {
  const {controller, session, docId} = useEngine();
  useSessionTick();
  useShellState();
  const doc: any = (() => { try { return session.get(docId); } catch { return null; } })();
  if (!doc?.file?.content?.pages?.length) return null;
  const notice = noticeOf(doc.file.content, doc.view ?? {}, (session as any).prefs ?? {});
  if (!notice) return null;
  const group: RibbonGroup | undefined = controller.model?.tabs.flatMap(t => t.groups).find(g => g.key === GROUP);
  const controls = (group?.controls ?? []).filter(isControl);
  const pick = (id: string) => controls.find(c => c.id === id && controller.shows(c));
  const buttons = [notice.fields ? 'notice.highlight-fields' : null, notice.security ? 'notice.security' : null, notice.unlock ? 'notice.unlock' : null,
    notice.dontShow ? 'notice.dont-show' : null].map(id => (id ? pick(id) : undefined)).filter((c): c is NonNullable<typeof c> => !!c);
  const dismiss = pick('notice.dismiss');
  return <div className="fa-notice" role="status" data-kind={notice.kind}>
    <Icon id={notice.icon as any} size={16}/>
    <span className="fa-notice-text">{notice.text}</span>
    <span className="fa-notice-buttons">
      {buttons.map(c => <RibbonControl key={c.id} c={c} size="medium"/>)}
      {dismiss ? <RibbonControl c={dismiss} size="small"/> : null}
    </span>
  </div>;
}
