// The picture of a table style in a gallery tile: a small table, each cell filled as the style fills it,
// its lines as the style draws them and bars for text in the style's text colour (bold for the strong cells).
// Pure SVG, drawn from the data a command's state gives an item (`art`).

export interface TableStyleArtData {
  kind: 'tablestyle';
  rows: number;
  cols: number;
  /** Row by row: the cell's fill (null for none), the text colour, whether the text is bold and the four sides (left, right, top, bottom) as [colour, width] or null. */
  cells: {fill: string | null; text: string | null; bold: boolean; sides: ([string, number] | null)[]}[];
}

export function TableStyleArt({art}: {art: TableStyleArtData}) {
  const w = 56, h = 44, px = 3, py = 3, cw = (w - px * 2) / art.cols, ch = (h - py * 2) / art.rows;
  return <svg className="tile-art tile-art-tablestyle" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" focusable="false">
    <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={2} fill="#fff" stroke="rgba(128,128,128,.45)"/>
    {art.cells.map((c, i) => {
      const r = Math.floor(i / art.cols), k = i % art.cols, x = px + k * cw, y = py + r * ch;
      return <g key={i}>
        {c.fill ? <rect x={x} y={y} width={cw} height={ch} fill={c.fill}/> : null}
        <rect x={x + 3} y={y + ch / 2 - (c.bold ? 1.1 : 0.8)} width={cw - 6} height={c.bold ? 2.2 : 1.6} fill={c.text ?? '#555'} opacity={c.text ? 0.9 : 0.55}/>
      </g>;
    })}
    {art.cells.flatMap((c, i) => {
      const r = Math.floor(i / art.cols), k = i % art.cols, x = px + k * cw, y = py + r * ch;
      const edges = [[x, y, x, y + ch], [x + cw, y, x + cw, y + ch], [x, y, x + cw, y], [x, y + ch, x + cw, y + ch]];
      return c.sides.map((s, j) => (s ? <line key={`${i}-${j}`} x1={edges[j][0]} y1={edges[j][1]} x2={edges[j][2]} y2={edges[j][3]} stroke={s[0]} strokeWidth={s[1]}/> : null));
    })}
  </svg>;
}
