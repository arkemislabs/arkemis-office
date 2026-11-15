// The Design Ideas pane (Design > Design Ideas): offline suggestions. The current slide arranged by
// each layout idea (picture full-bleed with the title on a band, picture beside the text, a framed
// picture, text-only layouts), then the presentation in each built-in theme. A click runs
// design.applyIdea or design.theme. Everything is computed on the device.
// Translated from deckcraft crates/ui-egui/src/panels/designer.rs at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {useMemo} from 'react';
import {useEngine} from '../../../shell/engine/EngineProvider';
import {useSessionTick} from '../../../shell/engine/useCommand';
import {toCommandError} from '../../../../core/kernel/errors.mjs';
import type {PaneProps} from '../../../shell/panes/PaneHost';
import {currentSlideId} from '../../../../core/prism/model/doc.mjs';
import {ideasFor, applyIdea} from '../../../../core/prism/lib/ideas.mjs';
import {masterIndexOf} from '../../../../core/prism/commands/design.mjs';
import {builtinThemes} from '../../../../core/prism/model/theme.mjs';
import {SlideView} from '../surface/SlideView';
import './designer.css';

type Any = any;

export default function DesignerPane(_: PaneProps) {
  const {controller, session, docId} = useEngine();
  const tick = useSessionTick();
  const model = useMemo(() => {
    try {
      const d: Any = session.get(docId);
      const content = d.file.content;
      const index = Math.max((content.slides ?? []).findIndex((s: Any) => s.id === currentSlideId(content, d.selection)), 0);
      const slide = content.slides?.[index];
      if (!slide) return null;
      const ideas = ideasFor(content, index).map(([id, label]: string[]) => {
        let shapes: Any = null;
        try { shapes = applyIdea(content, index, id); } catch { shapes = null; }
        return shapes ? {id, label, content, slide: {...slide, shapes}} : null;
      }).filter(Boolean);
      const mi = masterIndexOf(content, slide);
      const themes = builtinThemes().map((th: Any) => ({name: th.name, content: {...content, masters: content.masters.map((m: Any, i: number) => (i === mi ? {...m, theme: th} : m))}, slide}));
      return {ideas, themes, current: content.masters?.[mi]?.theme?.name ?? ''};
    } catch { return null; }
  }, [session, docId, tick]);

  const fail = (e: unknown) => controller.notify(toCommandError(e).message, 'error');
  const run = (id: string, params: Record<string, unknown>) => controller.run(id, params, {origin: 'ui'}).catch(fail);
  if (!model) return <div className="dsg"><small className="dsg-note">Open a slide to see design ideas.</small></div>;
  const {ideas, themes, current} = model;
  return <div className="dsg">
    <small className="dsg-note">Pick a design for this slide. Ideas are generated on your device.</small>
    {!ideas.length ? <small className="dsg-note">Add a title with a picture or some text to get layout ideas.</small> : null}
    {ideas.map((i: Any) => <button key={i.id} type="button" className="dsg-thumb" data-idea={i.id} title={i.label} aria-label={i.label} onClick={() => run('design.applyIdea', {id: i.id})}>
      <SlideView content={i.content} slide={i.slide} className="dsg-slide"/></button>)}
    <small className="dsg-note dsg-h">Themes (whole presentation)</small>
    {themes.map((t: Any) => <button key={t.name} type="button" className={`dsg-thumb${t.name === current ? ' is-on' : ''}`} data-theme={t.name} title={t.name} aria-label={t.name} onClick={() => run('design.theme', {name: t.name})}>
      <SlideView content={t.content} slide={t.slide} className="dsg-slide"/></button>)}
  </div>;
}
