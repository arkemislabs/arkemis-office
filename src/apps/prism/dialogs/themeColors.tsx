// Create New Theme Colors' sample: a slide-like box in the background colours with text, a hyperlink and a
// followed hyperlink in their colours, and the six accents as a bar (PowerPoint draws the same sample).

import type {SpecField} from '../../../generated/spec-types';

type Sample = {bg: string; bg2: string; text: string; text2: string; hlink: string; folHlink: string; accents: string[]};

function SampleBox({field, preview}: {values: Record<string, unknown>; preview: unknown; field: SpecField}) {
  const s = (preview ?? null) as Sample | null;
  if (!s) return null;
  return <div className="sf" data-field-id={field.id} data-kind="preview">
    <div role="img" aria-label="Theme colors sample" style={{background: s.bg, color: s.text, borderRadius: 8, padding: '10px 12px', border: '1px solid rgba(128,128,128,.4)', font: '13px var(--ark-font, system-ui)'}}>
      <div style={{display: 'flex', gap: 14, alignItems: 'baseline'}}>
        <span style={{fontSize: 18, fontWeight: 600}}>Text</span>
        <span style={{color: s.text2}}>Secondary</span>
        <span style={{color: s.hlink, textDecoration: 'underline'}}>Hyperlink</span>
        <span style={{color: s.folHlink, textDecoration: 'underline'}}>Followed</span>
      </div>
      <div style={{display: 'flex', height: 12, marginTop: 8, borderRadius: 3, overflow: 'hidden', background: s.bg2}}>
        {s.accents.map((c, i) => <span key={i} style={{flex: 1, background: c}}/>)}
      </div>
    </div>
  </div>;
}

export default {Preview: SampleBox};
