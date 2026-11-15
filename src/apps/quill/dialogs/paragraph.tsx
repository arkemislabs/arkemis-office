// Paragraph dialog view (Home › Paragraph launcher): Word's three pages, Indents and Spacing (General,
// Indentation, Spacing, Preview, Tabs…), Line and Page Breaks, Asian Typography, over
// core/quill/dialogs/paragraph.mjs. Layout from wordcraft crates/ui-egui/src/dialogs/dispatch.rs
// `paragraph_dialog` and Word's dialog at aadb077e072b7de05f724e359d8db82e151f125c.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.

import {PageTabs, Field, Group, grid, usePreview, ParagraphPreview, type BodyProps} from './font';

function Body({dialog: d, setValue: set}: BodyProps) {
  const p = usePreview(d);
  const page = d.spec.tabs[d.tab]?.name ?? 'Indents and Spacing';
  const F = (id: string) => <Field d={d} id={id} set={set}/>;
  return <div className="gd-fields" data-dialog-page={page}>
    <PageTabs dialog={d}/>
    {page === 'Indents and Spacing' ? <>
      <Group title="General">
        <div style={grid('repeat(2, minmax(0, 1fr))')}>{F('alignment')}{F('outlineLevel')}</div>
        <div style={{marginTop: 8}}>{F('direction')}</div>
      </Group>
      <Group title="Indentation">
        <div style={grid('repeat(2, minmax(0, 1fr)) minmax(0, 1.1fr) minmax(0, .9fr)')}>{F('left')}{F('right')}{F('special')}{F('by')}</div>
        <div style={{marginTop: 8}}>{F('mirrorIndents')}</div>
      </Group>
      <Group title="Spacing">
        <div style={grid('repeat(2, minmax(0, 1fr)) minmax(0, 1.1fr) minmax(0, .9fr)')}>{F('before')}{F('after')}{F('lineRule')}<div>{F('lineAt')}{F('lineAtPt')}</div></div>
        <div style={{marginTop: 8}}>{F('contextualSpacing')}</div>
      </Group>
      <ParagraphPreview p={p}/>
      <div style={{marginTop: 10}}>{F('tabsButton')}</div>
    </> : page === 'Line and Page Breaks' ? <>
      <Group title="Pagination">
        <div style={{display: 'grid', gap: 7}}>{F('widowControl')}{F('keepNext')}{F('keepLines')}{F('pageBreakBefore')}</div>
      </Group>
      <Group title="Formatting exceptions">
        <div style={{display: 'grid', gap: 7}}>{F('suppressLineNumbers')}{F('suppressHyphens')}</div>
      </Group>
      <ParagraphPreview p={p}/>
    </> : <>
      <Group title="Line break">
        <div style={{display: 'grid', gap: 7}}>{F('kinsoku')}{F('wordWrap')}{F('overflowPunct')}</div>
      </Group>
      <Group title="Character spacing">
        <div style={{display: 'grid', gap: 7}}>{F('topLinePunct')}{F('autoSpaceDE')}{F('autoSpaceDN')}</div>
      </Group>
      <ParagraphPreview p={p}/>
    </>}
  </div>;
}

export default {Body};
