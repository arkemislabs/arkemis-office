// The notes pane under the slide (View › Notes): the current slide's speaker notes as an editable
// draft. Typing edits the draft (the notes' text through deckcraft `edit::replace_text`, so runs
// that weren't touched keep their formatting) and the draft is saved with `slide.notes {body}`
// once the editor loses focus, as deckcraft does. "Click to add notes" shows while it is empty.
// Follows deckcraft crates/ui-egui/src/panels/notes.rs (Draft, typed, save on focus loss) at
// f893f6af7d36a5409fd804e81a34fd895cfefedf. F:prism surface.

import {useEffect, useRef, useState} from 'react';
import type {SurfaceProps} from '../../../shell/AppHost';
import {bodyText} from '../../../../core/prism/model/text.mjs';
import {replaceText} from '../../../../core/prism/model/edit.mjs';

type Any = any;

export function NotesPane({controller, slide, index}: {controller: SurfaceProps['controller']; slide: Any; index: number}) {
  const saved = bodyText(slide.notes ?? {paragraphs: []});
  const [draft, setDraft] = useState<{slide: string; text: string; edited: boolean}>({slide: slide.id, text: saved, edited: false});
  const ref = useRef<HTMLTextAreaElement>(null);
  // Another slide, or the notes changed elsewhere while not being edited: show them.
  useEffect(() => {
    setDraft(d => (d.slide !== slide.id || !d.edited ? {slide: slide.id, text: saved, edited: false} : d));
  }, [slide.id, saved]);
  const canSave = controller.hasCommand('slide.notes');
  const save = () => {
    if (!draft.edited || draft.slide !== slide.id) return;
    const body = replaceText(slide.notes ?? {body: {}, paragraphs: []}, draft.text);
    setDraft(d => ({...d, edited: false}));
    void controller.run('slide.notes', {body, index}, {origin: 'ui'}).catch((e: Any) => controller.notify(String(e?.message ?? e), 'error'));
  };
  return <div className="prism-notes">
    <textarea ref={ref} className="prism-notes-text" aria-label="Notes" placeholder="Click to add notes" value={draft.slide === slide.id ? draft.text : saved}
      readOnly={!canSave} spellCheck onChange={e => setDraft({slide: slide.id, text: e.target.value, edited: true})} onBlur={save}/>
  </div>;
}
