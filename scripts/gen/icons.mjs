// Icon pipeline (docs/architecture.md section 12): sanitize assets/icons/ribbon/<id>.svg (and
// <id>.32.svg) into src/generated/icons.ts, enforcing the drawing rules, and assign each icon id
// one owning unit.
import fs from 'node:fs';
import path from 'node:path';
import {walk, rel} from './util.mjs';

export const ICON_DIR = 'assets/icons/ribbon';
const ELEMENTS = new Set(['g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const ATTRS = new Set(['d', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2', 'points',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'fill-rule', 'clip-rule', 'opacity', 'fill-opacity', 'stroke-opacity', 'class', 'transform']);
const ROOT_PAINT = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule'];
const GRID_ATTRS = new Set(['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'width', 'height', 'r', 'rx', 'ry']);
const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const ICON_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Shared basics the integrator draws in Phase 0 so no unit waits on them (12.4). */
export const SHARED_BASICS = new Set(['undo', 'redo', 'undo-2', 'redo-2', 'save', 'cut', 'copy', 'paste', 'clipboard-paste', 'bold', 'bold-B',
  'italic', 'italic-I', 'underline', 'underline-U', 'align-left', 'align-center', 'align-right', 'align-justify', 'alignLeft', 'alignCenter',
  'alignRight', 'bullets', 'numbering', 'list-bullets', 'list-numbers', 'list', 'list-ordered']);

const onGrid = (n, step) => Math.abs(n / step - Math.round(n / step)) < 1e-6;

/** Minimal tokenizer for the restricted SVG subset icons may use. */
function tokenize(text) {
  const tokens = [];
  const re = /<!--[\s\S]*?-->|<\?xml[^>]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/\s*([A-Za-z][\w:.-]*)\s*>|<\s*([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].startsWith('<!--') || m[0].startsWith('<?xml')) continue;
    if (m[0].startsWith('<![CDATA[')) tokens.push({type: 'bad', what: 'CDATA'});
    else if (m[0].startsWith('<!')) tokens.push({type: 'bad', what: 'DOCTYPE or declaration'});
    else if (m[1]) tokens.push({type: 'close', name: m[1]});
    else if (m[2]) tokens.push({type: 'open', name: m[2], attrs: m[3] || '', self: m[4] === '/'});
    else if (m[5] !== undefined) { if (m[5].trim()) tokens.push({type: 'text', text: m[5].trim()}); }
    else tokens.push({type: 'bad', what: 'a stray "<"'});
  }
  return tokens;
}

function parseAttrs(s) {
  const out = [];
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) out.push([m[1], m[2] ?? m[3] ?? '']);
  return out;
}

const escapeAttr = v => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Check one icon file against the drawing rules and return its sanitized inner markup.
 * @param {string} text SVG source
 * @param {{size?: 24|32}} [opts]
 * @returns {{inner: string, errors: string[]}}
 */
export function checkSvg(text, {size = 24} = {}) {
  const errors = [];
  const err = m => { if (!errors.includes(m)) errors.push(m); };
  const tokens = tokenize(String(text).replace(/^﻿/, ''));
  const strokeWidth = size === 32 ? 2 : 1.5;
  const stack = [];
  const out = [];
  let root = null;
  let rootClosed = false;
  for (const t of tokens) {
    if (t.type === 'bad') { err(`contains ${t.what}`); continue; }
    if (t.type === 'text') { err('contains text content'); continue; }
    if (rootClosed) { err('content after </svg>'); continue; }
    if (t.type === 'open' && !root) {
      if (t.name !== 'svg') { err('the root element must be <svg>'); continue; }
      root = {attrs: new Map(parseAttrs(t.attrs))};
      for (const [k] of root.attrs) {
        if (/^on/i.test(k)) err(`root has event attribute ${k}`);
        else if (!['xmlns', 'viewBox', ...ROOT_PAINT].includes(k)) err(`root attribute ${k} is not allowed (only xmlns, viewBox and paint defaults; no width/height)`);
      }
      if (root.attrs.get('xmlns') !== 'http://www.w3.org/2000/svg') err('root needs xmlns="http://www.w3.org/2000/svg"');
      if (root.attrs.get('viewBox') !== `0 0 ${size} ${size}`) err(`root needs viewBox="0 0 ${size} ${size}"`);
      if (t.self) rootClosed = true;
      continue;
    }
    if (!root) { err('the root element must be <svg>'); continue; }
    if (t.type === 'close') {
      if (t.name === 'svg' && !stack.length) { rootClosed = true; continue; }
      if (stack[stack.length - 1] !== t.name) { err(`mismatched </${t.name}>`); continue; }
      stack.pop();
      out.push(`</${t.name}>`);
      continue;
    }
    if (!ELEMENTS.has(t.name)) { err(`element <${t.name}> is not allowed (only ${[...ELEMENTS].join(', ')})`); if (!t.self) stack.push(t.name); continue; }
    const attrs = parseAttrs(t.attrs);
    const kept = [];
    for (const [k, v] of attrs) {
      if (/^on/i.test(k)) { err(`event attribute ${k} is not allowed`); continue; }
      if (k === 'id' || k === 'style' || /href$/i.test(k)) { err(`attribute ${k} is not allowed`); continue; }
      if (!ATTRS.has(k)) { err(`attribute ${k} is not allowed`); continue; }
      if ((k === 'fill' || k === 'stroke') && !['currentColor', 'none'].includes(v)) err(`${k}="${v}": paint with currentColor (class="accent" or "tone" for the second colours)`);
      if (k === 'class' && !v.split(/\s+/).every(c => c === 'accent' || c === 'tone')) err(`class="${v}": only "accent" and "tone" are allowed`);
      if (k === 'stroke-width' && Number(v) !== strokeWidth) err(`stroke-width must be ${strokeWidth} at ${size} px`);
      if ((k === 'stroke-linecap' || k === 'stroke-linejoin') && v !== 'round') err(`${k} must be round`);
      if (k === 'transform' && !/^(\s*(translate|rotate|scale)\(\s*-?[\d.]+(\s*[ ,]\s*-?[\d.]+){0,2}\s*\)\s*)+$/.test(v)) err(`transform="${v}" may only translate, rotate or scale`);
      if (GRID_ATTRS.has(k) && !(v.match(NUM) || []).every(n => onGrid(Number(n), 0.5))) err(`${k}="${v}" is off the half-pixel grid`);
      if (k === 'points' && !(v.match(NUM) || []).every(n => onGrid(Number(n), 0.5))) err('points are off the half-pixel grid');
      if (k === 'd' && !(v.match(NUM) || []).every(n => onGrid(Number(n), 0.25))) err('path data is off the quarter-pixel grid');
      kept.push(`${k}="${escapeAttr(v)}"`);
    }
    out.push(`<${t.name}${kept.length ? ' ' + kept.join(' ') : ''}${t.self ? '/>' : '>'}`);
    if (!t.self) stack.push(t.name);
  }
  if (!root) err('no <svg> root');
  else if (!rootClosed) err('missing </svg>');
  if (stack.length) err(`unclosed <${stack[stack.length - 1]}>`);
  for (const [k, v] of root?.attrs ?? []) {
    if ((k === 'fill' || k === 'stroke') && !['currentColor', 'none'].includes(v)) err(`root ${k}="${v}": paint with currentColor`);
    if (k === 'stroke-width' && Number(v) !== strokeWidth) err(`stroke-width must be ${strokeWidth} at ${size} px`);
    if ((k === 'stroke-linecap' || k === 'stroke-linejoin') && v !== 'round') err(`${k} must be round`);
  }
  let inner = out.join('');
  const paint = [...(root?.attrs ?? [])].filter(([k]) => ROOT_PAINT.includes(k));
  if (paint.length) inner = `<g ${paint.map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(' ')}>${inner}</g>`;
  return {inner, errors};
}

/** Read and check every icon file. Problems are errors (the rules are enforced). */
export function loadIcons(root, report) {
  const dir = path.join(root, ICON_DIR);
  const icons = {};
  for (const file of walk(dir, n => n.endsWith('.svg'))) {
    const r = rel(root, file);
    if (path.dirname(file) !== dir) { report.error(r, 'icons live directly in assets/icons/ribbon'); continue; }
    const base = path.basename(file, '.svg');
    const large = base.endsWith('.32');
    const id = large ? base.slice(0, -3) : base;
    if (!ICON_ID.test(id) && !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(id)) { report.error(r, `"${id}" is not a kebab-case icon id`); continue; }
    const {inner, errors} = checkSvg(fs.readFileSync(file, 'utf8'), {size: large ? 32 : 24});
    for (const e of errors) report.error(r, e);
    if (errors.length) continue;
    icons[id] = icons[id] || {};
    icons[id][large ? 'd32' : 'd24'] = inner;
  }
  for (const [id, v] of Object.entries(icons)) {
    if (!v.d24) { report.error(`${ICON_DIR}/${id}.32.svg`, `has no 24 px drawing ${id}.svg`); delete icons[id]; }
  }
  return icons;
}

export function iconsModule(icons) {
  const lines = ['// GENERATED by scripts/generate.mjs from assets/icons/ribbon. Do not edit.',
    'export interface IconMarkup { d24: string; d32?: string }',
    'export const icons: Record<string, IconMarkup> = {'];
  for (const id of Object.keys(icons).sort()) lines.push(`  ${JSON.stringify(id)}: ${JSON.stringify(icons[id])},`);
  lines.push('};', '');
  return lines.join('\n');
}

/**
 * One owner per icon id: the first unit, in app order and then spec order, whose controls use it.
 * `unitFor(app, control, tabId)` names the unit that owns a control. Shared basics belong to the integrator.
 */
export function assignIconOwners(models, unitFor) {
  const owners = {};
  for (const [app, model] of models) {
    if (!model) continue;
    const visit = (c, tabId) => {
      if (!c || c.separator || c.header) return;
      if (c.icon) {
        if (!owners[c.icon]) owners[c.icon] = {owner: SHARED_BASICS.has(c.icon) ? 'I' : unitFor(app, c, tabId), app, firstControl: c.id, uses: 0};
        owners[c.icon].uses++;
      }
      for (const k of c.items || []) visit(k, tabId);
    };
    for (const tab of model.tabs) for (const g of tab.groups) {
      // A collapsed group's icon is drawn by the app's icons unit (layout overlay units draw no icons).
      if (g.collapsedIcon && !owners[g.collapsedIcon]) owners[g.collapsedIcon] = {owner: SHARED_BASICS.has(g.collapsedIcon) ? 'I' : `U:${app}/icons`, app, firstControl: null, uses: 0};
      for (const c of g.controls) visit(c, tab.id);
    }
    for (const c of model.qat) visit(c, null);
  }
  return owners;
}
