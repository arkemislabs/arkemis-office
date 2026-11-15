// The master views (View › Slide Master, Handout Master, Notes Master): for the slide master, the master
// and its layouts as thumbnails with the open one drawn large; for the handout and notes masters, the
// page. The canvas is read-only: placeholders and graphics change with the contextual tab's commands
// (Insert Layout, Rename, Delete, Preserve, Title, Footers, Insert Placeholder, the placeholder check
// boxes, Background Styles, Themes, Colors, Fonts, Effects).
// deckcraft: crates/ui-egui/src/panels/thumbs.rs (the master and layout list), canvas (the open
// Target) at 4ce2944 / f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import type {SurfaceProps} from '../../../shell/AppHost';
import {SlideView} from './SlideView';
import {bodyFromText, bodyText} from '../../../../core/prism/model/text.mjs';

type Any = any;
type Ctl = SurfaceProps['controller'];
const SYNTH = '__master_view';

/** A content copy in which one slide stands for the open master, layout, handout or notes page. */
export function masterContent(content: Any, open: Any, layoutOverride?: number | null): {content: Any; slide: Any} | null {
  const synth = {id: SYNTH, name: '', kind: 'custom', shapes: [], background: null, showMasterShapes: true, preserve: false};
  if (open.kind === 'slide') {
    const mi = open.master, master = content.masters?.[mi];
    if (!master) return null;
    const li = layoutOverride === undefined ? open.layout : layoutOverride;
    const layout = li === null || li === undefined ? null : master.layouts?.[li];
    const slide = layout
      ? {id: '__vs', layout: layout.id, shapes: (layout.shapes ?? []).filter((s: Any) => s.ph), background: null, showMasterShapes: true, hidden: false, notes: {body: {}, paragraphs: []}, animations: [], comments: []}
      : {id: '__vs', layout: SYNTH, shapes: (master.shapes ?? []).filter((s: Any) => s.ph), background: null, showMasterShapes: true, hidden: false, notes: {body: {}, paragraphs: []}, animations: [], comments: []};
    const masters = content.masters.map((m: Any, i: number) => (i === mi && !layout ? {...m, layouts: [...(m.layouts ?? []), synth]} : m));
    return {content: {...content, masters, slides: [slide]}, slide};
  }
  const m = open.kind === 'handout' ? content.handoutMaster : content.notesMaster;
  if (!m) return null;
  // A page's header, date, footer, page number, slide image and notes body are drawn as boxes with their names, since a slide never shows footer placeholders.
  const label: Record<string, string> = {header: 'Header', date: 'Date', footer: 'Footer', slideNum: 'Page Number', slideImage: 'Slide Image', body: 'Click to edit Master text styles'};
  const boxes = (m.shapes ?? []).map((s: Any) => {
    const empty = !s.text || bodyText(s.text).trim() === '';
    const line = s.line ?? {fill: {kind: 'solid', color: {base: {kind: 'rgb', rgb: {r: 150, g: 150, b: 150, a: 255}}}}, width: 0.75};
    return {...s, ph: null, textBox: true, line, text: empty ? bodyFromText(label[s.ph?.kind] ?? '') : s.text};
  });
  const slide = {id: '__vs', layout: SYNTH, shapes: boxes, background: null, showMasterShapes: true, hidden: false, notes: {body: {}, paragraphs: []}, animations: [], comments: []};
  return {content: {...content, slideSize: content.notesSize ?? {width: 540, height: 720}, masters: [{...m, layouts: [synth]}], slides: [slide]}, slide};
}

/** The master and its layouts as thumbnails (Slide Master view); a click opens that one for editing on the canvas. */
export function MasterList({controller, content, open}: {controller: Ctl; content: Any; open: Any}) {
  const run = (id: string, params: Any) => controller.run(id, params, {origin: 'ui'}).catch((e: Any) => controller.notify(String(e?.message ?? e), 'error'));
  const master = open.kind === 'slide' ? content.masters[open.master] : null;
  if (!master) return null;
  return <div className="prism-master-list" role="listbox" aria-label="Master and layouts">
    {[null, ...(master.layouts ?? []).map((_: Any, i: number) => i)].map(li => {
      const v = masterContent(content, open, li);
      if (!v) return null;
      const on = (open.layout ?? null) === li;
      const name = li === null ? `${master.name || 'Slide'} Master` : master.layouts[li].name;
      const used = li !== null ? content.slides.filter((s: Any) => s.layout === master.layouts[li].id).length : 0;
      return <button key={li ?? 'master'} type="button" role="option" aria-selected={on} data-master-item={li ?? 'master'} className={`prism-master-item${on ? ' is-selected' : ''}${li === null ? ' is-master' : ''}`}
        title={name} onClick={() => run('view.slideMaster', li === null ? {master: open.master} : {master: open.master, layout: li})}>
        <span className="prism-master-img"><SlideView content={v.content} slide={v.slide} editor/></span>
        <span className="prism-master-name">{name}{used ? ` (${used})` : ''}</span>
      </button>;
    })}
  </div>;
}
