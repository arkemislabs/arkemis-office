const borderStyles=new Set(['thin','medium','thick','double','dotted','dashed','dashDot','dashDotDot','mediumDashed','mediumDashDot','mediumDashDotDot','slantDashDot','hair']);
const color=value=>value?.argb&&/^[0-9a-f]{8}$/i.test(value.argb)?'#'+value.argb.slice(2):undefined;
export function applyCellFormatting(cell,style,borderPatch){
 const result={...cell,...style};
 if(borderPatch&&Object.keys(borderPatch).length)result.borders=Object.fromEntries(Object.entries(result.borders??{}).map(([edge,border])=>[edge,{...border,...borderPatch}]));
 validateCellStyle(result);return result;
}
export function readCellStyle(c){
 const f=c.font??{},a=c.alignment??{},b={};for(const edge of ['top','bottom','left','right'])if(borderStyles.has(c.border?.[edge]?.style))b[edge]={style:c.border[edge].style,color:color(c.border[edge].color)??'#000000'};
 return {fontFamily:f.name??'Calibri',fontSize:f.size??11,bold:!!f.bold,italic:!!f.italic,underline:f.underline===true?'single':f.underline||'none',strike:!!f.strike,color:color(f.color),background:color(c.fill?.fgColor),align:a.horizontal,verticalAlign:a.vertical??'bottom',wrap:!!a.wrapText,rotation:typeof a.textRotation==='number'?a.textRotation:0,indent:a.indent??0,numFmt:c.numFmt??'General',borders:b};
}
export function writeCellStyle(out,c){
 out.font={name:c.fontFamily||'Calibri',size:c.fontSize??11,bold:!!c.bold,italic:!!c.italic,underline:c.underline&&c.underline!=='none'?c.underline:undefined,strike:!!c.strike,color:{argb:'FF'+(c.color||'#000000').slice(1)}};
 if(c.background)out.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF'+c.background.slice(1)}};
 out.alignment={horizontal:c.align??'left',vertical:c.verticalAlign??'bottom',wrapText:!!c.wrap,textRotation:c.rotation??0,indent:c.indent??0};
 if(c.numFmt)out.numFmt=c.numFmt;
 if(c.borders)out.border=Object.fromEntries(Object.entries(c.borders).map(([edge,b])=>[edge,{style:b.style,color:{argb:'FF'+b.color.slice(1)}}]));
}
export function validateCellStyle(c){
 for(const key of ['bold','italic','strike','wrap'])if(c[key]!==undefined&&typeof c[key]!=='boolean')throw Error('Invalid cell '+key);
 for(const key of ['color','background'])if(c[key]!==undefined&&!/^#[0-9a-f]{6}$/i.test(c[key]))throw Error('Invalid cell color');
 for(const [key,min,max] of [['fontSize',1,409],['rotation',-90,90],['indent',0,250]])if(c[key]!==undefined&&(!Number.isFinite(c[key])||c[key]<min||c[key]>max))throw Error('Invalid cell '+key);
 for(const [key,max] of [['fontFamily',200],['numFmt',255]])if(c[key]!==undefined&&(typeof c[key]!=='string'||c[key].length>max))throw Error('Invalid cell '+key);
 if(c.underline!==undefined&&!['none','single','double','singleAccounting','doubleAccounting'].includes(c.underline))throw Error('Invalid cell underline');
 if(c.borders!==undefined){if(!c.borders||typeof c.borders!=='object'||Array.isArray(c.borders))throw Error('Invalid cell borders');for(const [edge,b] of Object.entries(c.borders))if(!['top','bottom','left','right'].includes(edge)||!b||!borderStyles.has(b.style)||!/^#[0-9a-f]{6}$/i.test(b.color))throw Error('Invalid cell border');}
}
export function cellStyleCSS(c){const result={fontFamily:c.fontFamily,fontSize:c.fontSize?c.fontSize*4/3:undefined,fontWeight:c.bold?700:400,fontStyle:c.italic?'italic':undefined,textDecoration:[c.underline&&c.underline!=='none'?'underline':'',c.strike?'line-through':''].filter(Boolean).join(' ')||undefined,color:c.color,backgroundColor:c.background,whiteSpace:c.wrap?'pre-wrap':'nowrap',textAlign:c.align,verticalAlign:c.verticalAlign,paddingLeft:c.indent?8+c.indent*12:undefined};for(const [edge,b] of Object.entries(c.borders??{}))result['border'+edge[0].toUpperCase()+edge.slice(1)]=`${b.style==='double'?3:b.style==='thick'?3:b.style.startsWith('medium')?2:1}px ${b.style==='double'?'double':b.style==='dotted'?'dotted':b.style.toLowerCase().includes('dash')?'dashed':'solid'} ${b.color}`;return result;}
