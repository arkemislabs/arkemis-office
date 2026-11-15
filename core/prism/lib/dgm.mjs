// SmartArt as PowerPoint stores it (DrawingML diagrams): the outline <-> the data model (`ppt/diagrams/dataN.xml`), and the layout, quick style and
// colour definitions written for our own layouts (`layoutN.xml`, `quickStyleN.xml`, `colorsN.xml`). The drawing part (`drawingN.xml`, the shapes
// PowerPoint shows until it lays the diagram out) is written and read by the .pptx writer and reader.
// Translated from deckcraft crates/pptx/src/dgm.rs at 4ce2944. MIT, see assets/third-party-licenses/artcraft-reference.txt.
// Ours on top (not in deckcraft, written as PowerPoint stores them): the diagram direction (`dgm:dir`, Right to Left) and an organization chart's
// branch layout (`dgm:hierBranch`: std, init = Both, l, r) in the document point's `dgm:presLayoutVars`.
// No DOM, no Node built-ins. The readers take the .pptx reader's `El` tree (core/prism/formats/pptx-read.mjs).

export const NS_DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
export const NS_DSP = 'http://schemas.microsoft.com/office/drawing/2008/diagram';
export const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const CT_DATA = 'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml';
export const CT_LAYOUT = 'application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml';
export const CT_STYLE = 'application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml';
export const CT_COLORS = 'application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml';
export const CT_DRAWING = 'application/vnd.ms-office.drawingml.diagramDrawing+xml';
export const RT_DRAWING = 'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing';
const QS_BASE = 'urn:microsoft.com/office/officeart/2005/8/quickstyle/';
const CS_BASE = 'urn:microsoft.com/office/officeart/2005/8/colors/';
const MAX_NODES = 2000;
const MAX_LEVEL = 8;

const last = s => String(s ?? '').split('/').pop() ?? '';

/** PowerPoint's quick style for a SmartArt Style. */
export function qsId(style) {
  const s = {subtle: 'simple3', intense: 'simple5', outline: 'simple4', polished: '3d1', inset: '3d2', cartoon: '3d3', powder: '3d4', brick: '3d5'}[style] ?? 'simple1';
  return `${QS_BASE}${s}`;
}

/** The SmartArt Style closest to a quick style id. */
export function styleFor(qs) {
  switch (last(qs)) {
    case 'simple1': case '': return 'flat';
    case 'simple4': return 'outline';
    case '3d1': return 'polished';
    case '3d2': return 'inset';
    case '3d3': return 'cartoon';
    case '3d4': return 'powder';
    case '3d5': return 'brick';
    case 'simple2': case 'simple3': return 'subtle';
    default: return 'intense';
  }
}

const digit = (s, prefix) => { const m = new RegExp(`^${prefix}(\\d)`).exec(String(s ?? '')); return m ? Number(m[1]) : null; };

/** PowerPoint's colour definition for Change Colors. */
export function csId(colors) {
  const a = digit(colors, 'range');
  if (a !== null && a >= 2 && a <= 5) return `${CS_BASE}colorful${a}`;
  const n = digit(colors, 'accent');
  if (n !== null && n >= 1 && n <= 6) return `${CS_BASE}accent${n}_${String(colors).endsWith('Grad') ? 3 : 2}`;
  return `${CS_BASE}colorful1`;
}

/** The accents a Change Colors choice fills shapes with, in turn. */
function fillAccents(colors) {
  const a = digit(colors, 'range');
  if (a !== null && a >= 2 && a <= 5) return [`accent${a}`, `accent${a + 1}`];
  const n = digit(colors, 'accent');
  if (n !== null && n >= 1 && n <= 6) return [`accent${n}`];
  return [1, 2, 3, 4, 5, 6].map(k => `accent${k}`);
}

/** Change Colors from a colour definition id: `accentN_...` keeps accent N, anything else is colourful. */
export function colorsFor(cs) {
  const l = last(cs);
  const c = /^colorful(\d+)$/.exec(l);
  if (c && Number(c[1]) >= 2 && Number(c[1]) <= 5) return `range${c[1]}${Number(c[1]) + 1}`;
  const m = /^accent(\d)_(\d+)/.exec(l);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 6) return ['3', '4', '5'].includes(m[2]) ? `accent${m[1]}Grad` : `accent${m[1]}`;
  return 'colorful';
}

const LAYOUT_IDS = {
  blockList: 'default', hBulletList: 'hList1', process: 'process1', chevron: 'chevron1', verticalProcess: 'process2', stepUp: '2009/3:StepUpProcess', cycle: 'cycle2',
  blockCycle: 'cycle5', radial: 'radial1', hierarchy: 'hierarchy1', pyramid: 'pyramid1', invertedPyramid: 'pyramid3', matrix: 'matrix3', titledMatrix: 'matrix1',
  pictureList: 'vList4', pictureCaption: 'pList1', pictureProcess: 'hProcess10', pictureHList: 'pList2', timeline: 'hProcess11', venn: 'venn1', target: 'target1',
  textCycle: 'cycle1', continuousCycle: 'cycle3', horizontalHierarchy: 'hierarchy2', gridMatrix: 'matrix2', gear: 'gear1', funnel: 'funnel1', segmentedCycle: 'cycle8',
  multidirectionalCycle: 'cycle7', orgChart: 'orgChart1', halfCircleOrgChart: '2008:HalfCircleOrganizationChart', nameTitleOrgChart: '2008:NameandTitleOrganizationalChart',
  verticalBoxList: 'list1', trapezoidList: 'hList6', tableList: 'hList3', accentProcess: 'process3', continuousBlockProcess: 'hProcess9', bendingProcess: 'process5',
  linearVenn: 'venn3', stackedVenn: 'venn2', nestedTarget: 'target2', cycleMatrix: 'cycle4', segmentedPyramid: 'pyramid4', pie: 'chart3',
};
/** PowerPoint's built-in layout a layout `kind` is written as. */
export function layoutId(kind) {
  const v = LAYOUT_IDS[kind] ?? 'vList2';
  if (v.startsWith('2009/3:')) return `urn:microsoft.com/office/officeart/2009/3/layout/${v.slice(7)}`;
  if (v.startsWith('2008:')) return `urn:microsoft.com/office/officeart/2008/layout/${v.slice(5)}`;
  return `urn:microsoft.com/office/officeart/2005/8/layout/${v}`;
}

const KINDS = ['blockList', 'hBulletList', 'process', 'chevron', 'verticalProcess', 'stepUp', 'cycle', 'blockCycle', 'radial', 'hierarchy', 'pyramid', 'invertedPyramid', 'matrix',
  'titledMatrix', 'pictureList', 'pictureCaption', 'pictureProcess', 'pictureHList', 'timeline', 'venn', 'target', 'textCycle', 'continuousCycle', 'horizontalHierarchy', 'gridMatrix',
  'gear', 'funnel', 'segmentedCycle', 'multidirectionalCycle', 'orgChart', 'halfCircleOrgChart', 'nameTitleOrgChart', 'verticalBoxList', 'trapezoidList', 'tableList', 'accentProcess',
  'continuousBlockProcess', 'bendingProcess', 'linearVenn', 'stackedVenn', 'nestedTarget', 'cycleMatrix', 'segmentedPyramid', 'pie', 'list'];

/** The layout closest to a PowerPoint layout (by its id and category). */
export function kindFor(id, category = '') {
  const l = last(id).toLowerCase();
  // Picture Accent Process was once written as pList2 (Horizontal Picture List) in the process category; PowerPoint's pList2 is a list.
  if (l === 'plist2' && String(category).toLowerCase() === 'process') return 'pictureProcess';
  for (const k of KINDS) if (id === layoutId(k)) return k;
  const s = `${l} ${String(category).toLowerCase()}`;
  const has = t => s.includes(t);
  if (has('gear')) return 'gear';
  if (has('funnel')) return 'funnel';
  if (has('venn')) return 'venn';
  if (has('target')) return 'target';
  if (has('timeline')) return 'timeline';
  if (has('nameandtitle')) return 'nameTitleOrgChart';
  if (has('orgchart') || has('organizationchart') || has('organizationalchart')) return 'orgChart';
  if (has('hierarchy')) return 'hierarchy';
  if (has('radial')) return 'radial';
  if (has('cycle')) return 'cycle';
  if (has('pyramid')) return 'pyramid';
  if (has('matrix')) return 'matrix';
  if (has('chevron')) return 'chevron';
  if (has('process') || has('arrow')) return 'process';
  if (l === 'default') return 'blockList';
  if (l.startsWith('hlist')) return 'hBulletList';
  return 'list';
}

const CAT = [
  ['process', ['process', 'chevron', 'verticalProcess', 'stepUp', 'pictureProcess', 'timeline', 'gear', 'funnel', 'accentProcess', 'continuousBlockProcess', 'bendingProcess']],
  ['relationship', ['venn', 'target', 'linearVenn', 'stackedVenn', 'nestedTarget']],
  ['cycle', ['cycle', 'blockCycle', 'radial', 'textCycle', 'continuousCycle', 'segmentedCycle', 'multidirectionalCycle', 'cycleMatrix', 'pie']],
  ['hierarchy', ['hierarchy', 'horizontalHierarchy', 'orgChart', 'halfCircleOrgChart', 'nameTitleOrgChart']],
  ['pyramid', ['pyramid', 'invertedPyramid', 'segmentedPyramid']],
  ['matrix', ['matrix', 'titledMatrix', 'gridMatrix']],
];
const categoryOf = kind => CAT.find(([, v]) => v.includes(kind))?.[0] ?? 'list';
const isHierarchy = kind => ['hierarchy', 'horizontalHierarchy', 'orgChart', 'halfCircleOrgChart', 'nameTitleOrgChart'].includes(kind);

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escA = t => esc(t).replace(/"/g, '&quot;');
const hex = (n, width) => Math.max(0, Math.trunc(n)).toString(16).toUpperCase().padStart(width, '0');
/** A model id, stable for a given diagram (`seed`) and point number. */
const guid = (seed, n) => `{${hex(seed >>> 0, 8)}-D1A6-4C0A-9E5B-${hex(n, 12)}}`;

/** A tiny XML string builder. */
class X {
  constructor() { this.s = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'; }
  open(name, attrs = {}) { this.s += `<${name}${attrString(attrs)}>`; return this; }
  empty(name, attrs = {}) { this.s += `<${name}${attrString(attrs)}/>`; return this; }
  close(name) { this.s += `</${name}>`; return this; }
  elt(name, t) { this.s += `<${name}>${esc(t)}</${name}>`; return this; }
}
const attrString = a => Object.entries(a).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => ` ${k}="${escA(v)}"`).join('');

function text(w, t) {
  w.open('dgm:t').empty('a:bodyPr').empty('a:lstStyle').open('a:p');
  if (!t) w.empty('a:endParaRPr', {lang: 'en-US'});
  else w.open('a:r').empty('a:rPr', {lang: 'en-US'}).elt('a:t', t).close('a:r');
  w.close('a:p').close('dgm:t');
}

const BRANCH = {both: 'init', left: 'l', right: 'r'};
const BRANCH_BACK = {init: 'both', l: 'left', r: 'right'};

/** `ppt/diagrams/dataN.xml` for the outline. `drawingRel` is the slide's relationship id of the cached drawing; `pics` the data part's relationship ids of node pictures, as [node index, rId]. */
export function dataXml(d, seed, drawingRel, pics = []) {
  const lo = d.layoutId || layoutId(d.kind);
  const w = new X();
  w.open('dgm:dataModel', {'xmlns:dgm': NS_DGM, 'xmlns:a': NS_A, 'xmlns:r': NS_R});
  w.open('dgm:ptLst');
  const doc = guid(seed, 0);
  w.open('dgm:pt', {modelId: doc, type: 'doc'});
  const vars = [d.rtl ? '<dgm:dir val="rev"/>' : '', isHierarchy(d.kind) && BRANCH[d.hang] ? `<dgm:hierBranch val="${BRANCH[d.hang]}"/>` : ''].join('');
  const prSet = {loTypeId: lo, loCatId: categoryOf(d.kind), qsTypeId: qsId(d.style), qsCatId: 'simple', csTypeId: csId(d.colors),
    csCatId: String(d.colors ?? '').startsWith('accent') ? d.colors : 'colorful', phldr: '1'};
  if (vars) w.open('dgm:prSet', prSet).open('dgm:presLayoutVars').s += `${vars}</dgm:presLayoutVars></dgm:prSet>`;
  else w.empty('dgm:prSet', prSet);
  w.empty('dgm:spPr');
  text(w, '');
  w.close('dgm:pt');
  // Node k: model id 1 + 3k; its link's parent and sibling transitions 2 + 3k and 3 + 3k.
  const node = k => guid(seed, 1 + 3 * k);
  const nodes = d.nodes.slice(0, MAX_NODES);
  nodes.forEach((n, k) => {
    w.open('dgm:pt', {modelId: node(k), ...(n.assistant ? {type: 'asst'} : {})});
    w.empty('dgm:prSet', {phldrT: '[Text]'}).empty('dgm:spPr');
    text(w, n.text);
    w.close('dgm:pt');
    const cxn = guid(seed, 0x100000 + k);
    for (const [i, ty] of [[2, 'parTrans'], [3, 'sibTrans']]) {
      w.open('dgm:pt', {modelId: guid(seed, i + 3 * k), type: ty, cxnId: cxn}).empty('dgm:prSet').empty('dgm:spPr');
      text(w, '');
      w.close('dgm:pt');
    }
  });
  // Name and Title: a node's title is the text of its title box's presentation point.
  nodes.forEach((n, k) => {
    if (!n.title) return;
    w.open('dgm:pt', {modelId: guid(seed, 0x300000 + k), type: 'pres'});
    w.empty('dgm:prSet', {presAssocID: node(k), presName: 'titleText1', presStyleLbl: 'fgAcc1', custT: '1'}).empty('dgm:spPr');
    text(w, n.title);
    w.close('dgm:pt');
  });
  // A node's picture sits on the presentation point of its picture placeholder (`presAssocID` names the node; the blip is a relationship of the data part).
  for (const [k, rid] of pics) {
    if (k >= nodes.length) continue;
    w.open('dgm:pt', {modelId: guid(seed, 0x200000 + k), type: 'pres'});
    w.empty('dgm:prSet', {presAssocID: node(k), presName: 'Image', presStyleLbl: 'fgImgPlace1'});
    w.open('dgm:spPr').open('a:blipFill').empty('a:blip', {'r:embed': rid}).open('a:stretch').empty('a:fillRect').close('a:stretch').close('a:blipFill').close('dgm:spPr');
    w.close('dgm:pt');
  }
  w.close('dgm:ptLst');
  w.open('dgm:cxnLst');
  let stack = [];
  const ords = new Map();
  nodes.forEach((n, k) => {
    while (stack.length && stack.at(-1)[0] >= n.level) stack.pop();
    const parent = stack.length ? stack.at(-1)[1] : doc;
    const ord = ords.get(parent) ?? 0;
    w.empty('dgm:cxn', {modelId: guid(seed, 0x100000 + k), srcId: parent, destId: node(k), srcOrd: ord, destOrd: 0, parTransId: guid(seed, 2 + 3 * k), sibTransId: guid(seed, 3 + 3 * k)});
    ords.set(parent, ord + 1);
    stack.push([n.level, node(k)]);
  });
  w.close('dgm:cxnLst');
  w.empty('dgm:bg').empty('dgm:whole');
  w.open('dgm:extLst').open('a:ext', {uri: 'http://schemas.microsoft.com/office/drawing/2008/diagram'});
  w.empty('dsp:dataModelExt', {'xmlns:dsp': NS_DSP, relId: drawingRel, minVer: NS_DGM});
  w.close('a:ext').close('dgm:extLst').close('dgm:dataModel');
  return w.s;
}

/** A text body's paragraphs joined by spaces. */
function paragraphs(t) {
  return t.childrenNamed('p').map(p => p.findAll('t').map(e => e.text()).join('')).filter(s => s.trim()).join(' ');
}

/** The document point's `prSet`. */
const docSet = data => data.child('ptLst')?.childrenNamed('pt').find(p => p.attr('type') === 'doc')?.child('prSet') ?? null;

/** The outline of a data part with its model ids: the `parOf` tree under the document point, depth first. */
function outlineIds(data) {
  const pts = data.child('ptLst');
  if (!pts) return [];
  const texts = new Map(), titles = new Map(), assistants = new Set();
  let doc = null;
  for (const pt of pts.childrenNamed('pt').slice(0, MAX_NODES * 4)) {
    const id = pt.attr('modelId');
    if (id === null) continue;
    const ty = pt.attr('type') ?? 'node';
    if (ty === 'doc') doc = doc ?? id;
    else if (ty === 'node' || ty === 'asst') {
      texts.set(id, pt.child('t') ? paragraphs(pt.child('t')) : '');
      if (ty === 'asst') assistants.add(id);
    } else if (ty === 'pres') {
      const pr = pt.child('prSet');
      const t = pt.child('t') ? paragraphs(pt.child('t')) : '';
      if ((pr?.attr('presName') ?? '').startsWith('titleText') && pr.attr('presAssocID') !== null && t) titles.set(pr.attr('presAssocID'), t);
    }
  }
  if (doc === null) return [];
  const kids = new Map();
  for (const c of (data.child('cxnLst')?.childrenNamed('cxn') ?? []).slice(0, MAX_NODES * 4)) {
    if ((c.attr('type') ?? 'parOf') !== 'parOf') continue;
    const src = c.attr('srcId'), dst = c.attr('destId');
    if (src === null || dst === null || !texts.has(dst)) continue;
    if (!kids.has(src)) kids.set(src, []);
    kids.get(src).push([c.i64('srcOrd') ?? 0, dst]);
  }
  for (const v of kids.values()) v.sort((a, b) => a[0] - b[0]);
  const out = [];
  const seen = new Set();
  // Depth first, iteratively; a node reached twice (a cycle in a hostile file) is skipped.
  const stack = (kids.get(doc) ?? []).map(([, id]) => [id, 0]).reverse();
  while (stack.length) {
    const [id, level] = stack.pop();
    if (out.length >= MAX_NODES || seen.has(id)) continue;
    seen.add(id);
    const node = {text: texts.get(id) ?? '', level: Math.min(level, MAX_LEVEL)};
    if (assistants.has(id)) node.assistant = true;
    if (titles.get(id)) node.title = titles.get(id);
    out.push([id, node]);
    const v = kids.get(id);
    if (v) for (const [, c] of [...v].reverse()) stack.push([c, level + 1]);
  }
  return out;
}

/** The outline of a data part (`dgm:dataModel`): the nodes depth first. */
export const outline = data => outlineIds(data).map(([, n]) => n);

/** The relationship ids (of the data part) of node pictures, as [node index, rId]: the blip fill of a presentation point associated with the node. */
export function nodePictures(data) {
  const ids = new Map(outlineIds(data).map(([id], k) => [id, k]));
  const out = [];
  for (const pt of (data.child('ptLst')?.childrenNamed('pt') ?? []).slice(0, MAX_NODES * 8)) {
    if (pt.attr('type') !== 'pres') continue;
    const k = ids.get(pt.child('prSet')?.attr('presAssocID') ?? '');
    const rid = pt.child('spPr')?.child('blipFill')?.child('blip')?.attr('r:embed');
    if (k === undefined || !rid) continue;
    if (!out.some(([j]) => j === k)) out.push([k, rid]);
  }
  return out;
}

/** The diagram direction and branch layout the document point records: {rtl, hang}. */
export function layoutVars(data) {
  const vars = docSet(data)?.child('presLayoutVars');
  return {rtl: vars?.child('dir')?.attr('val') === 'rev', hang: BRANCH_BACK[vars?.child('hierBranch')?.attr('val') ?? ''] ?? null};
}

/** The layout, style and colour ids the document point names: {lo, qs, cs}. */
export function docIds(data) {
  const pr = docSet(data);
  return {lo: pr?.attr('loTypeId') ?? '', qs: pr?.attr('qsTypeId') ?? '', cs: pr?.attr('csTypeId') ?? ''};
}

/** The layout algorithm and node shape of a layout. */
function alg(kind) {
  switch (kind) {
    case 'process': case 'stepUp': case 'pictureProcess': case 'pictureCaption': case 'pictureHList': case 'timeline': return ['lin', [['linDir', 'fromL'], ['nodeVertAlign', 'mid']], 'roundRect'];
    case 'chevron': return ['lin', [['linDir', 'fromL'], ['nodeVertAlign', 'mid']], 'chevron'];
    case 'verticalProcess': return ['lin', [['linDir', 'fromT'], ['nodeHorzAlign', 'ctr']], 'roundRect'];
    case 'cycle': case 'radial': case 'venn': case 'target': case 'textCycle': case 'continuousCycle': case 'gear': case 'segmentedCycle': case 'multidirectionalCycle':
    case 'cycleMatrix': case 'pie': return ['cycle', [['stAng', '0'], ['spanAng', '360']], 'ellipse'];
    case 'blockCycle': return ['cycle', [['stAng', '0'], ['spanAng', '360']], 'roundRect'];
    case 'pyramid': case 'invertedPyramid': case 'segmentedPyramid': return ['pyra', [['linDir', kind === 'pyramid' ? 'fromT' : 'fromB'], ['txDir', 'fromT'], ['pyraAcctPos', 'bef']], 'trapezoid'];
    case 'matrix': case 'titledMatrix': case 'gridMatrix': case 'blockList':
      return ['snake', [['grDir', 'tL'], ['flowDir', 'row'], ['contDir', 'sameDir'], ['off', 'ctr']], kind === 'blockList' ? 'rect' : 'roundRect'];
    case 'hBulletList': return ['lin', [['linDir', 'fromL'], ['nodeVertAlign', 't']], 'roundRect'];
    default: return ['lin', [['linDir', 'fromT'], ['vertAlign', 'mid']], 'roundRect'];
  }
}

function nodeLayout(w, shape, bullets) {
  w.open('dgm:layoutNode', {name: 'node'});
  w.open('dgm:varLst').empty('dgm:bulletEnabled', {val: bullets ? '1' : '0'}).close('dgm:varLst');
  w.empty('dgm:alg', {type: 'tx'});
  w.open('dgm:shape', {type: shape, 'r:blip': ''}).empty('dgm:adjLst').close('dgm:shape');
  w.empty('dgm:presOf', {axis: bullets ? 'desOrSelf' : 'self', ptType: 'node'});
  w.open('dgm:constrLst');
  for (const side of ['tMarg', 'bMarg', 'lMarg', 'rMarg']) w.empty('dgm:constr', {type: side, refType: 'primFontSz', fact: '0.3'});
  w.close('dgm:constrLst');
  w.open('dgm:ruleLst').empty('dgm:rule', {type: 'primFontSz', val: '5', fact: 'NaN', max: 'NaN'}).close('dgm:ruleLst');
  w.close('dgm:layoutNode');
}

function space(w) {
  w.open('dgm:forEach', {name: 'sibling', axis: 'followSib', ptType: 'sibTrans', cnt: '1'});
  w.open('dgm:layoutNode', {name: 'space'}).empty('dgm:alg', {type: 'sp'});
  w.open('dgm:shape', {'r:blip': ''}).empty('dgm:adjLst').close('dgm:shape');
  w.empty('dgm:presOf').empty('dgm:constrLst').empty('dgm:ruleLst');
  w.close('dgm:layoutNode').close('dgm:forEach');
}

const shapeBase = w => { w.open('dgm:shape', {'r:blip': ''}).empty('dgm:adjLst').close('dgm:shape'); w.empty('dgm:presOf').empty('dgm:constrLst').empty('dgm:ruleLst'); };

/** `ppt/diagrams/layoutN.xml`: a layout definition for layout `kind`, under the id of the closest built-in PowerPoint layout. */
export function layoutXml(kind) {
  const w = new X();
  w.open('dgm:layoutDef', {'xmlns:dgm': NS_DGM, 'xmlns:a': NS_A, 'xmlns:r': NS_R, uniqueId: layoutId(kind)});
  w.empty('dgm:title', {val: ''}).empty('dgm:desc', {val: ''});
  w.open('dgm:catLst').empty('dgm:cat', {type: categoryOf(kind), pri: '1000'}).close('dgm:catLst');
  w.open('dgm:layoutNode', {name: 'diagram'});
  w.open('dgm:varLst').empty('dgm:dir').empty('dgm:resizeHandles', {val: 'exact'}).close('dgm:varLst');
  if (isHierarchy(kind)) {
    // Each node over the row of its children, recursively.
    w.empty('dgm:alg', {type: 'hierChild'});
    shapeBase(w);
    w.open('dgm:forEach', {name: 'level', axis: 'ch', ptType: 'node'});
    w.open('dgm:layoutNode', {name: 'hierRoot'}).empty('dgm:alg', {type: 'hierRoot'});
    shapeBase(w);
    nodeLayout(w, 'roundRect', false);
    w.open('dgm:layoutNode', {name: 'hierChild'}).empty('dgm:alg', {type: 'hierChild'});
    shapeBase(w);
    w.empty('dgm:forEach', {name: 'repeat', ref: 'level'});
    w.close('dgm:layoutNode').close('dgm:layoutNode').close('dgm:forEach');
  } else {
    const [ty, params, shape] = alg(kind);
    w.open('dgm:alg', {type: ty});
    for (const [k, v] of params) w.empty('dgm:param', {type: k, val: v});
    w.close('dgm:alg');
    w.open('dgm:shape', {'r:blip': ''}).empty('dgm:adjLst').close('dgm:shape');
    w.empty('dgm:presOf');
    w.open('dgm:constrLst');
    w.empty('dgm:constr', {type: 'w', for: 'ch', forName: 'node', refType: 'w'});
    w.empty('dgm:constr', {type: 'h', for: 'ch', forName: 'node', refType: 'w', refFor: 'ch', refForName: 'node', fact: '0.6'});
    w.empty('dgm:constr', {type: 'w', for: 'ch', forName: 'space', refType: 'w', refFor: 'ch', refForName: 'node', fact: '0.1'});
    w.empty('dgm:constr', {type: 'primFontSz', for: 'ch', forName: 'node', op: 'equ', val: '65'});
    w.close('dgm:constrLst').empty('dgm:ruleLst');
    w.open('dgm:forEach', {name: 'nodes', axis: 'ch', ptType: 'node'});
    nodeLayout(w, shape, true);
    if (!['cycle', 'blockCycle', 'radial'].includes(kind)) space(w);
    w.close('dgm:forEach');
  }
  w.close('dgm:layoutNode').close('dgm:layoutDef');
  return w.s;
}

/** The top bevel (preset, width in EMU) of a 3-D SmartArt Style. */
const bevel = style => ({polished: ['circle', 76200], inset: ['relaxedInset', 63500], cartoon: ['softRound', 50800], powder: ['convex', 101600], brick: ['slope', 50800]}[style] ?? null);

/** `ppt/diagrams/quickStyleN.xml`: flat shapes drawn from the theme's first styles. */
export function styleXml(style) {
  // Brick Scene looks at the diagram from above and to the side.
  const camera = style === 'brick' ? 'isometricOffAxis2Top' : 'orthographicFront';
  const w = new X();
  w.open('dgm:styleDef', {'xmlns:dgm': NS_DGM, 'xmlns:a': NS_A, uniqueId: qsId(style)});
  w.empty('dgm:title', {val: ''}).empty('dgm:desc', {val: ''});
  w.open('dgm:catLst').empty('dgm:cat', {type: bevel(style) ? '3D' : 'simple', pri: '10100'}).close('dgm:catLst');
  w.open('dgm:scene3d').empty('a:camera', {prst: camera}).empty('a:lightRig', {rig: 'threePt', dir: 't'}).close('dgm:scene3d');
  w.open('dgm:styleLbl', {name: 'node1'});
  w.open('dgm:scene3d').empty('a:camera', {prst: camera}).empty('a:lightRig', {rig: 'threePt', dir: 't'}).close('dgm:scene3d');
  const b = bevel(style);
  if (b) w.open('dgm:sp3d').empty('a:bevelT', {w: b[1], h: Math.trunc((b[1] * 3) / 5), prst: b[0]}).close('dgm:sp3d');
  else w.empty('dgm:sp3d');
  w.empty('dgm:txPr');
  w.open('dgm:style');
  for (const [tag, idx] of [['a:lnRef', '2'], ['a:fillRef', '1'], ['a:effectRef', '0']]) w.open(tag, {idx}).empty('a:scrgbClr', {r: '0', g: '0', b: '0'}).close(tag);
  w.open('a:fontRef', {idx: 'minor'}).empty('a:schemeClr', {val: 'lt1'}).close('a:fontRef');
  w.close('dgm:style').close('dgm:styleLbl').close('dgm:styleDef');
  return w.s;
}

/** `ppt/diagrams/colorsN.xml`: the accents Change Colors fills shapes with, light text. */
export function colorsXml(colors) {
  const w = new X();
  w.open('dgm:colorsDef', {'xmlns:dgm': NS_DGM, 'xmlns:a': NS_A, uniqueId: csId(colors)});
  w.empty('dgm:title', {val: ''}).empty('dgm:desc', {val: ''});
  const accents = fillAccents(colors);
  const cat = accents.length === 1 ? accents[0] : 'colorful';
  w.open('dgm:catLst').empty('dgm:cat', {type: cat, pri: '11200'}).close('dgm:catLst');
  w.open('dgm:styleLbl', {name: 'node1'});
  w.open('dgm:fillClrLst', {meth: 'repeat'});
  if (String(colors ?? '').endsWith('Grad')) {
    // Gradient Range: the accent shaded darker across the shapes.
    for (let k = 0; k < 4; k++) w.open('a:schemeClr', {val: cat}).empty('a:lumMod', {val: 100000 - k * 15000}).close('a:schemeClr');
  } else for (const a of accents) w.empty('a:schemeClr', {val: a});
  w.close('dgm:fillClrLst');
  w.open('dgm:linClrLst', {meth: 'repeat'}).empty('a:schemeClr', {val: 'lt1'}).close('dgm:linClrLst');
  w.empty('dgm:effectClrLst').empty('dgm:txLinClrLst').empty('dgm:txFillClrLst').empty('dgm:txEffectClrLst');
  w.close('dgm:styleLbl').close('dgm:colorsDef');
  return w.s;
}
