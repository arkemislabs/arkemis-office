// New Tag / Modify Tag: the Preview draws a tagged line the way a note carries it (symbol icon, then the display name in the tag's font
// colour on its highlight), over core/slate/dialogs/tag-editor.mjs. The Symbol list, drawn with its icons, is the shell's list field.
// Slate has no ArtCraft upstream.

import type {ComponentType} from 'react';
import type {SpecField} from '../../../generated/spec-types';
import {Icon} from '../../../shell/icons/Icon';
import {tagIcon} from '../../../../core/slate/lib/tags-catalog.mjs';

type Data = {name?: string; symbol?: string; fontColor?: string | null; highlightColor?: string | null};

function Preview({preview}: {values: Record<string, unknown>; preview: unknown; field: SpecField}) {
  const d = (preview ?? {}) as Data;
  const symbol = d.symbol ?? 'none';
  // A little note page: the line above and below in grey, the tagged line between them as the note carries it.
  return <div>
    <div className="sf-label">Preview</div>
    <div className="sf-tag-preview" role="img" aria-label={`Tag preview: ${d.name ?? ''}`}>
      <i style={{width: '64%'}}/>
      <div className="sf-tag-preview-line">
        <span className="sf-tag-preview-icon">{symbol !== 'none' ? <Icon id={tagIcon({symbol})} size={16}/> : null}</span>
        <span className="sf-tag-preview-text" style={{color: d.fontColor || undefined, background: d.highlightColor || undefined}}>{d.name || 'Tag'}</span>
      </div>
      <i style={{width: '82%'}}/><i style={{width: '48%'}}/>
    </div>
  </div>;
}

export default {Preview: Preview as ComponentType<{values: Record<string, unknown>; preview: unknown; field: SpecField}>};
