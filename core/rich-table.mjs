// Table span/property adaptation from WordCraft 3de6ff95af86c19d67030cd96dba15cd6a45a25e,
// crates/docx/src/read/props.rs and write/props.rs. See wordcraft-tables.txt MIT notice.
export const tableBorderStyles=['single','double','dashed','dotted','nil'];
export function cellFormatting(attrs={}){
 const result={};if(attrs.backgroundColor!=null){if(!/^#[0-9a-f]{6}$/i.test(attrs.backgroundColor))throw new Error('Invalid cell fill');result.backgroundColor=attrs.backgroundColor;}
 if(attrs.verticalAlign!=null){if(!['top','center','bottom'].includes(attrs.verticalAlign))throw new Error('Invalid cell vertical alignment');result.verticalAlign=attrs.verticalAlign;}
 if(attrs.cellBorders!=null){result.cellBorders={};for(const[side,b]of Object.entries(attrs.cellBorders)){if(!['top','bottom','left','right'].includes(side)||!b||!tableBorderStyles.includes(b.style)||!/^#[0-9a-f]{6}$/i.test(b.color)||!Number.isFinite(b.size)||b.size<0||b.size>12)throw new Error('Invalid cell border');result.cellBorders[side]={style:b.style,color:b.color,size:b.size};}}
 return result;
}
export function tableGrid(table){
 const rows=table.content??[];if(!rows.length||rows.length>500)throw new Error('Table must have 1 to 500 rows');const grid=Array.from({length:rows.length},()=>[]),cells=[],widths=[];let columns=0;
 for(let row=0;row<rows.length;row++){if(rows[row].type!=='tableRow')throw new Error('Invalid table row');let col=0;for(const cell of rows[row].content??[]){if(!['tableCell','tableHeader'].includes(cell.type))throw new Error('Invalid table cell');while(grid[row][col])col++;const a=cell.attrs??{},colspan=a.colspan??1,rowspan=a.rowspan??1;if(!Number.isInteger(colspan)||!Number.isInteger(rowspan)||colspan<1||rowspan<1||colspan>63||row+rowspan>rows.length||col+colspan>63)throw new Error('Invalid table cell span');cellFormatting(a);const entry={cell,row,col,colspan,rowspan};cells.push(entry);
  if(a.colwidth!=null){if(!Array.isArray(a.colwidth)||a.colwidth.length!==colspan||a.colwidth.some(w=>!Number.isFinite(w)||w<0||w>2000))throw new Error('Invalid table column width');for(let n=0;n<colspan;n++){if(a.colwidth[n]===0)continue;if(widths[col+n]!==undefined&&Math.abs(widths[col+n]-a.colwidth[n])>.1)throw new Error('Conflicting table column widths');widths[col+n]=a.colwidth[n];}}
  for(let r=row;r<row+rowspan;r++)for(let c=col;c<col+colspan;c++){if(grid[r][c])throw new Error('Overlapping table cell span');grid[r][c]=entry;}col+=colspan;columns=Math.max(columns,col);
 }}
 for(const row of grid)for(let col=0;col<columns;col++)if(!row[col])throw new Error('Table must be rectangular');return {grid,cells,columns,widths:Array.from({length:columns},(_,i)=>widths[i]??null)};
}
export function cellStyle(attrs={}){const a=cellFormatting(attrs),styles=[];if(a.backgroundColor)styles.push(`background-color:${a.backgroundColor}`);if(a.verticalAlign)styles.push(`vertical-align:${a.verticalAlign==='center'?'middle':a.verticalAlign}`);for(const[side,b]of Object.entries(a.cellBorders??{}))styles.push(`border-${side}:${b.style==='nil'?'none':`${b.size}pt ${{single:'solid',double:'double',dashed:'dashed',dotted:'dotted'}[b.style]} ${b.color}`}`);return styles.join(';');}
