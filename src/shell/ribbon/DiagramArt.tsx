// A SmartArt layout drawn small: the items core/prism/lib/smartart.mjs `thumb` gives (each shape's drawn path, its place as a matrix, the accent it is
// painted in, pale or ghost, connector lines, the SmartArt style), as SVG.

import {useId} from 'react';

type Any = any;
const ACCENT: Record<string, string> = {accent1: '#4472c4', accent2: '#ed7d31', accent3: '#a5a5a5', accent4: '#ffc000', accent5: '#5b9bd5', accent6: '#70ad47'};
const dark = (hex: string, k: number) => `#${[1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('')}`;
const pale = (hex: string, k: number) => `#${[1, 3, 5].map(i => Math.round(255 - (255 - parseInt(hex.slice(i, i + 2), 16)) * k).toString(16).padStart(2, '0')).join('')}`;

export function DiagramArt({items, w = 160, h = 100}: {items: Any[]; w?: number; h?: number}) {
  const uid = useId().replace(/:/g, '');
  const style = items[0]?.style ?? 'flat';
  return <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%" role="img" aria-label="SmartArt layout" preserveAspectRatio="xMidYMid meet">
    <defs>
      <filter id={`sh${uid}`} x="-20%" y="-20%" width="150%" height="150%"><feDropShadow dx="1.5" dy="2" stdDeviation="1.6" floodOpacity=".4"/></filter>
      {items.map((it, i) => (style === 'intense' && it.fill ? <linearGradient key={i} id={`g${uid}${i}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={pale(ACCENT[it.fill] ?? ACCENT.accent1, 0.7)}/><stop offset="1" stopColor={dark(ACCENT[it.fill] ?? ACCENT.accent1, 0.75)}/></linearGradient> : null))}
    </defs>
    <rect x={0} y={0} width={w} height={h} fill="#ffffff"/>
    {items.map((it, i) => {
      const base = ACCENT[it.fill] ?? ACCENT.accent1;
      const transform = `matrix(${it.m.join(' ')})`;
      if (it.line) return <g key={i} transform={transform}>{it.paths.map((p: Any, k: number) => <path key={k} d={p.d} fill="none" stroke={dark(ACCENT.accent1, 0.6)} strokeWidth={1.1}/>)}</g>;
      let fill = it.pale ? pale(base, 0.22) : base;
      let stroke = '#ffffff';
      let sw = 0.8;
      let filter: string | undefined;
      if (!it.pale) {
        if (style === 'outline') { fill = '#ffffff'; stroke = base; sw = 1.6; }
        else if (style === 'intense' && it.fill) { fill = `url(#g${uid}${i})`; filter = `url(#sh${uid})`; }
        else if (style === 'subtle') filter = `url(#sh${uid})`;
        else if (['polished', 'inset', 'cartoon', 'powder', 'brick'].includes(style)) {
          filter = style === 'inset' ? undefined : `url(#sh${uid})`;
          if (style === 'powder') fill = pale(base, 0.45);
          if (style === 'cartoon') { stroke = '#222222'; sw = 1.4; }
        }
      }
      return <g key={i} transform={transform} filter={filter} opacity={it.alpha ? it.alpha / 100000 + 0.15 : undefined}>
        {it.paths.map((p: Any, k: number) => <path key={k} d={p.d} fill={fill} stroke={stroke} strokeWidth={sw} fillRule="evenodd"/>)}
      </g>;
    })}
  </svg>;
}
