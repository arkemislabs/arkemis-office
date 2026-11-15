const path=require('node:path').posix;
const {XMLParser}=require('fast-xml-parser');
const parser=new XMLParser({ignoreAttributes:false,preserveOrder:true,parseTagValue:false,trimValues:false});
const tag=node=>Object.keys(node??{}).find(k=>k!==':@');
const kids=node=>node?.[tag(node)]??[];
const first=(nodes,name)=>(nodes??[]).find(n=>tag(n)===name);
const all=(nodes,name)=>(nodes??[]).filter(n=>tag(n)===name);
const attr=(node,name,fallback)=>node?.[':@']?.['@_'+name]??fallback;
const descend=(nodes,name)=>(nodes??[]).flatMap(n=>tag(n)===name?[n]:Array.isArray(kids(n))?descend(kids(n),name):[]);
const text=nodes=>(nodes??[]).map(n=>tag(n)==='#text'?String(n['#text']):Array.isArray(kids(n))?text(kids(n)):'').join('');
async function xml(zip,name){const file=zip.file(name);if(!file)return [];const source=await file.async('string');if(/<!DOCTYPE|<!ENTITY/i.test(source))throw new Error('XML document type declarations are not supported');return parser.parse(source);}
async function relations(zip,name){const root=await xml(zip,path.join(path.dirname(name),'_rels',path.basename(name)+'.rels'));return Object.fromEntries(descend(root,'Relationship').map(n=>[attr(n,'Id'),{target:attr(n,'Target'),external:attr(n,'TargetMode')==='External',type:attr(n,'Type')} ]));}
const resolve=(source,target)=>path.normalize(path.join(path.dirname(source),target??''));
async function image(zip,source,rel){if(!rel||rel.external)return null;const name=resolve(source,rel.target);if(!/\.(png|jpe?g)$/i.test(name))return null;const f=zip.file(name);if(!f)return null;const bytes=await f.async('nodebuffer');if(bytes.length>5_000_000)return null;return `data:image/${/\.png$/i.test(name)?'png':'jpeg'};base64,${bytes.toString('base64')}`;}
const color=(nodes,fallback)=>attr(descend(nodes,'a:srgbClr')[0],'val',fallback).replace(/^#/,'');

async function importWord(zip,createFile,title){
 const {tableGrid}=await import('../core/rich-table.mjs');
 const {paragraphDecoration,paragraphBorderSides}=await import('../core/rich-paragraph.mjs');
 let source='word/document.xml',rels=await relations(zip,source);const root=await xml(zip,source);
 const body=descend(root,'w:body')[0];if(!body)throw new Error('.docx body is missing');
 const numbering=await xml(zip,'word/numbering.xml');const abstractNumbers=new Map(descend(numbering,'w:abstractNum').map(n=>[attr(n,'w:abstractNumId'),n]));
 const numbers=new Map(descend(numbering,'w:num').map(n=>[attr(n,'w:numId'),attr(first(kids(n),'w:abstractNumId'),'w:val')]));
 async function inline(nodes,extra=[]){const result=[];let pending=null,pendingMarks=[],resultPhase=false,resultSeen=false;const field=(instruction,marks=[])=>{const code=String(instruction).trim();if(!/^(PAGE|NUMPAGES)(?:\s+\\\*\s+MERGEFORMAT)?$/i.test(code))throw Error('Unsupported Word field instruction: '+code.slice(0,80));const kind=code.split(/\s+/)[0].toUpperCase();if(!['PAGE','NUMPAGES'].includes(kind))throw Error('This Word field is not supported: '+kind);return {type:'wordField',attrs:{kind},...(marks.length?{marks}:{})};};
  for(const n of nodes??[]){const type=tag(n),c=kids(n);
   if(type==='w:fldSimple'){const cached=await inline(c,extra);result.push(field(attr(n,'w:instr',''),cached.find(n=>n.marks)?.marks??extra));continue;}
   if(type==='w:hyperlink'){const href=rels[attr(n,'r:id')]?.target;result.push(...await inline(c,/^(https?:|mailto:|tel:)/i.test(href??'')?[...extra,{type:'link',attrs:{href}}]:extra));}
   if(type!=='w:r')continue;
   const props=kids(first(c,'w:rPr')),marks=[...extra];
   for(const [key,type] of [['w:b','bold'],['w:i','italic'],['w:u','underline'],['w:strike','strike']]){const v=first(props,key);if(v&&!['0','false','none'].includes(attr(v,'w:val','true')))marks.push({type});}
   const styling={};const fonts=first(props,'w:rFonts'),size=Number(attr(first(props,'w:sz'),'w:val')),ink=attr(first(props,'w:color'),'w:val');
   if(fonts)styling.fontFamily=attr(fonts,'w:ascii',attr(fonts,'w:hAnsi','Arial'));if(size>0&&size<=384)styling.fontSize=size/2;if(/^[0-9A-F]{6}$/i.test(ink??''))styling.color='#'+ink;
   const fill=attr(first(props,'w:shd'),'w:fill'),vertical=attr(first(props,'w:vertAlign'),'w:val');if(/^[0-9a-f]{6}$/i.test(fill??''))styling.backgroundColor='#'+fill;if(vertical==='subscript'||vertical==='superscript')styling.verticalAlign=vertical==='subscript'?'sub':'super';
   if(Object.keys(styling).length)marks.push({type:'textStyle',attrs:styling});
   for(const item of c){const it=tag(item);if(it==='w:fldChar'){const phase=attr(item,'w:fldCharType');if(phase==='begin'){if(pending!==null)throw Error('Nested Word fields are not supported');pending='';pendingMarks=marks;resultPhase=false;resultSeen=false;}else if(phase==='separate'&&pending!==null){resultPhase=true;}else if(phase==='end'&&pending!==null){result.push(field(pending,pendingMarks));pending=null;}continue;}if(it==='w:instrText'){if(pending!==null)pending+=text(kids(item));continue;}if(pending!==null){if(resultPhase&&it==='w:t'&&!resultSeen){pendingMarks=marks;resultSeen=true;}continue;}if(tag(item)==='w:t'){const value=text(kids(item));if(value)result.push({type:'text',text:value,...(marks.length?{marks}:{})});}
    if(tag(item)==='w:tab')result.push({type:'text',text:'\t'});
    if(tag(item)==='w:br')result.push({type:attr(item,'w:type')==='page'?'pageBreak':'hardBreak'});
   }
  }if(pending!==null)throw Error('Incomplete Word field');return result;
 }
 async function readTable(nodes){
  const props=kids(first(nodes,'w:tblPr')),grid=all(kids(first(nodes,'w:tblGrid')),'w:gridCol').map(n=>Number(attr(n,'w:w'))/15),rawRows=all(nodes,'w:tr');if(!rawRows.length||rawRows.length>500||grid.length>63)throw new Error('Table exceeds supported dimensions');
  const inherited=kids(first(props,'w:tblBorders')),rows=[],active=new Map();
  const border=node=>{if(!node)return null;let style=attr(node,'w:val','single');if(style==='none')style='nil';if(!['single','double','dashed','dotted','nil'].includes(style))throw new Error(`Unsupported table border style: ${style}`);const value=attr(node,'w:color','000000'),ink=value==='auto'?'000000':value,size=Number(attr(node,'w:sz',style==='nil'?0:4))/8;if(!/^[0-9a-f]{6}$/i.test(ink)||!Number.isFinite(size)||size<0||size>12)throw new Error('Invalid Word table border');return {style,color:'#'+ink,size};};
  for(const[rowIndex,row]of rawRows.entries()){
   const rp=kids(first(kids(row),'w:trPr'));if(['w:gridBefore','w:gridAfter'].some(key=>Number(attr(first(rp,key),'w:val',0))>0))throw new Error('Tables with omitted grid cells are not supported');const header=first(rp,'w:tblHeader'),isHeader=!!header&&!['0','false','off'].includes(attr(header,'w:val','true')),cells=[],next=new Map();let col=0;
   for(const raw of all(kids(row),'w:tc')){
    const cp=kids(first(kids(raw),'w:tcPr'));if(first(cp,'w:hMerge'))throw new Error('Legacy horizontal table merges are not supported');const colspan=Number(attr(first(cp,'w:gridSpan'),'w:val',1));if(!Number.isInteger(colspan)||colspan<1||colspan>63||col+colspan>63)throw new Error('Invalid Word table span');const attrs={colspan,rowspan:1};
    let widths=grid.slice(col,col+colspan);if(widths.length!==colspan||widths.some(w=>!Number.isFinite(w)||w<=0)){const width=first(cp,'w:tcW');widths=attr(width,'w:type','dxa')==='dxa'?Array(colspan).fill(Number(attr(width,'w:w'))/15/colspan):[];}if(widths.length===colspan&&widths.every(w=>Number.isFinite(w)&&w>=1&&w<=2000))attrs.colwidth=widths.map(w=>Math.round(w*100)/100);
    const fill=attr(first(cp,'w:shd'),'w:fill'),vertical=attr(first(cp,'w:vAlign'),'w:val');if(/^[0-9a-f]{6}$/i.test(fill??''))attrs.backgroundColor='#'+fill;if(['top','center','bottom'].includes(vertical))attrs.verticalAlign=vertical;
    const direct=kids(first(cp,'w:tcBorders')),borders={};for(const side of ['top','bottom','left','right']){const fallback=side==='top'?(rowIndex===0?'top':'insideH'):side==='bottom'?(rowIndex===rawRows.length-1?'bottom':'insideH'):side==='left'?(col===0?'left':'insideV'):(col+colspan===grid.length?'right':'insideV');const b=border(first(direct,'w:'+side)??first(inherited,'w:'+fallback));if(b)borders[side]=b;}if(Object.keys(borders).length)attrs.cellBorders=borders;
    const merge=first(cp,'w:vMerge'),continuation=!!merge&&attr(merge,'w:val')!=='restart',content=await blocks(kids(raw));
    if(continuation){const origin=active.get(col);if(!origin||origin.attrs.colspan!==colspan||Array.from({length:colspan},(_,i)=>active.get(col+i)).some(c=>c!==origin))throw new Error('Invalid vertical table merge continuation');origin.attrs.rowspan++;if(content.some(n=>n.type!=='paragraph'||(n.content??[]).length))origin.content.push(...content);if(borders.bottom)origin.attrs.cellBorders={...(origin.attrs.cellBorders??{}),bottom:borders.bottom};for(let n=0;n<colspan;n++)next.set(col+n,origin);}
    else{const cell={type:isHeader?'tableHeader':'tableCell',attrs,content};cells.push(cell);if(merge)for(let n=0;n<colspan;n++)next.set(col+n,cell);}col+=colspan;
   }
   active.clear();for(const[k,v]of next)active.set(k,v);rows.push({type:'tableRow',content:cells});
  }
  const align=attr(first(props,'w:jc'),'w:val','left'),table={type:'table',attrs:{tableAlign:['left','center','right'].includes(align)?align:'left'},content:rows};tableGrid(table);return table;
 }
 async function blocks(nodes){const result=[];let listKey=null;
  for(const n of nodes??[]){const type=tag(n),c=kids(n);
   if(type==='w:tbl'){listKey=null;result.push(await readTable(c));}
   if(type!=='w:p')continue;
   const props=kids(first(c,'w:pPr')),style=attr(first(props,'w:pStyle'),'w:val',''),heading=/^Heading([1-6])$/i.exec(style);
   const align=attr(first(props,'w:jc'),'w:val','left'),node={type:heading?'heading':'paragraph',attrs:{textAlign:align==='both'?'justify':align,...(heading?{level:Number(heading[1])}:{})},content:await inline(c)};
   const shading=attr(first(props,'w:shd'),'w:fill');if(shading==='auto'||/^[0-9a-f]{6}$/i.test(shading??''))node.attrs.paragraphShading=shading==='auto'?'auto':'#'+shading;
   const rawBorders=first(props,'w:pBdr');if(rawBorders){node.attrs.paragraphBorders={};for(const side of paragraphBorderSides){const b=first(kids(rawBorders),'w:'+side);if(b){const style=attr(b,'w:val','single'),color=attr(b,'w:color','auto');node.attrs.paragraphBorders[side]={style:style==='none'?'nil':style,width:Number(attr(b,'w:sz',style==='nil'?0:4))/8,color:color==='auto'?'auto':'#'+color,space:Number(attr(b,'w:space',0))};}}}paragraphDecoration(node.attrs);
   const indent=first(props,'w:ind');for(const [attribute,key] of [['w:left','indentLeft'],['w:right','indentRight'],['w:firstLine','indentFirstLine'],['w:hanging','indentFirstLine']]){const raw=attr(indent,attribute),value=Number(raw);if(raw!==undefined&&Number.isFinite(value)&&value>=0&&value<=14400)node.attrs[key]=value/20*(attribute==='w:hanging'?-1:1);}
   const spacing=first(props,'w:spacing'),line=Number(attr(spacing,'w:line')),rule=attr(spacing,'w:lineRule','auto');if(rule==='auto'&&Number.isFinite(line)&&line>=192&&line<=720)node.attrs.lineHeight=line/240;for(const [attribute,key] of [['w:before','spaceBefore'],['w:after','spaceAfter']]){const raw=attr(spacing,attribute),value=Number(raw);if(raw!==undefined&&Number.isFinite(value)&&value>=0&&value<=1920)node.attrs[key]=value/20;}
   const num=first(props,'w:numPr'),id=attr(first(kids(num),'w:numId'),'w:val');
   if(id&&id!=='0'){const abstract=abstractNumbers.get(numbers.get(id)),format=attr(descend(kids(abstract),'w:numFmt')[0],'w:val','bullet'),kind=format==='bullet'?'bulletList':'orderedList';
    if(listKey!==id||result.at(-1)?.type!==kind)result.push({type:kind,content:[]});result.at(-1).content.push({type:'listItem',content:[node]});listKey=id;
   }else{result.push(node);listKey=null;}
   for(const drawing of descend(c,'a:blip')){const src=await image(zip,source,rels[attr(drawing,'r:embed')]);if(src)result.push({type:'image',attrs:{src}});}
  }return result.length?result:[{type:'paragraph'}];
 }
 const sections=descend(kids(body),'w:sectPr');if(sections.length>1)throw Error('Documents with multiple sections cannot yet be preserved.');
 const f=createFile('quill',title);f.content.doc={type:'doc',content:await blocks(kids(body))};
 const section=sections[0],hf={},settings=await xml(zip,'word/settings.xml');
 const enabled=n=>!!n&&!['0','false','off'].includes(attr(n,'w:val','true'));
 if(enabled(first(kids(section),'w:titlePg')))hf.differentFirstPage=true;
 if(enabled(descend(settings,'w:evenAndOddHeaders')[0]))hf.evenAndOdd=true;
 const mainRels=rels;for(const [element,key]of [['w:headerReference','headers'],['w:footerReference','footers']])for(const ref of all(kids(section),element)){
  const slot=attr(ref,'w:type','default'),rel=mainRels[attr(ref,'r:id')];if(!['default','first','even'].includes(slot)||!rel||rel.external)throw Error('Invalid header/footer reference');
  source=resolve('word/document.xml',rel.target);if(!source.startsWith('word/')||!zip.file(source))throw Error('Missing header/footer part');rels=await relations(zip,source);
  const part=await xml(zip,source);(hf[key]??={})[slot]={type:'doc',content:await blocks(kids(first(part,key==='headers'?'w:hdr':'w:ftr')))};
 }
 if(Object.keys(hf).length)f.content.headerFooter=hf;return f;
}

async function importPresentation(zip,createFile,title){
 const {flattenGroupTransform,shapeGeometries}=await import('../core/prism-content.mjs');
 const theme=await xml(zip,'ppt/theme/theme1.xml'),palette={};for(const n of kids(descend(theme,'a:clrScheme')[0])){const key=tag(n)?.replace('a:',''),rgb=attr(descend(kids(n),'a:srgbClr')[0],'val')??attr(descend(kids(n),'a:sysClr')[0],'lastClr');if(rgb)palette[key]=rgb;}Object.assign(palette,{tx1:palette.dk1,bg1:palette.lt1,tx2:palette.dk2,bg2:palette.lt2});
 const themeFont={'+mj-lt':attr(descend(kids(descend(theme,'a:majorFont')[0]),'a:latin')[0],'typeface','Aptos'),'+mn-lt':attr(descend(kids(descend(theme,'a:minorFont')[0]),'a:latin')[0],'typeface','Aptos')};
 const slideColor=(nodes,fallback)=>{const direct=color(nodes,'');if(direct)return direct;const scheme=descend(nodes,'a:schemeClr')[0];return palette[attr(scheme,'val')]??fallback;};
 const root=await xml(zip,'ppt/presentation.xml'),rels=await relations(zip,'ppt/presentation.xml');
 const size=descend(root,'p:sldSz')[0],cx=Number(attr(size,'cx',12192000)),cy=Number(attr(size,'cy',6858000));
 const sx=960/cx,sy=540/cy;const ids=descend(root,'p:sldId');
 const names=ids.map(n=>rels[attr(n,'r:id')]).filter(Boolean).map(r=>resolve('ppt/presentation.xml',r.target));
 if(!names.length||names.length>500)throw new Error('Presentation must contain 1 to 500 slides');
 const f=createFile('prism',title);f.content.slides=[];
 for(const name of names){const slideRoot=await xml(zip,name),slideRels=await relations(zip,name),tree=descend(slideRoot,'p:spTree')[0],background=slideColor(kids(descend(slideRoot,'p:bg')[0]),'FFFFFF');
  const slide={id:crypto.randomUUID(),background:'#'+background,elements:[],notes:'',hidden:['0','false'].includes(attr(descend(slideRoot,'p:sld')[0],'show','1')),name:attr(descend(slideRoot,'p:cSld')[0],'name','')};
  const readTransform=(transform)=>{const off=first(kids(transform),'a:off'),ext=first(kids(transform),'a:ext');return {x:Number(attr(off,'x',0))*sx,y:Number(attr(off,'y',0))*sy,w:Number(attr(ext,'cx',cx*.8))*sx,h:Number(attr(ext,'cy',cy*.2))*sy,rotation:Number(attr(transform,'rot',0))/60000,flipH:['1','true'].includes(attr(transform,'flipH','0')),flipV:['1','true'].includes(attr(transform,'flipV','0'))};};
  const readStyle=(node,defaults={})=>{const r={...defaults};for(const [key,attribute] of [['bold','b'],['italic','i']])if(attr(node,attribute)!==undefined)r[key]=['1','true'].includes(attr(node,attribute));if(attr(node,'u')!==undefined)r.underline=!['none','0'].includes(attr(node,'u'));if(attr(node,'sz')!==undefined)r.fontSize=Number(attr(node,'sz'))/100;const font=attr(first(kids(node),'a:latin'),'typeface');if(font)r.fontFamily=themeFont[font]??font;const col=slideColor(kids(node),'');if(col)r.color='#'+col;return r;};
  async function walk(nodes,groups=[]){if(groups.length>32)throw Error('Slide groups exceed supported depth');for(const n of nodes){const type=tag(n),c=kids(n);if(type==='p:grpSp'){const transform=first(kids(first(c,'p:grpSpPr')),'a:xfrm'),g=readTransform(transform),off=first(kids(transform),'a:chOff'),ext=first(kids(transform),'a:chExt');const child={x:Number(attr(off,'x',0))*sx,y:Number(attr(off,'y',0))*sy,w:Number(attr(ext,'cx',0))*sx,h:Number(attr(ext,'cy',0))*sy};await walk(c,[...groups,{g,child,id:attr(descend(c,'p:cNvPr')[0],'name','Group')}]);continue;}if(!['p:sp','p:pic','p:cxnSp'].includes(type)){if(type==='p:graphicFrame')throw Error('This presentation contains a table, chart or diagram that Prism cannot yet preserve.');continue;}
   if(slide.elements.length>=500)throw Error('Slide contains more than 500 editable objects');
   const shapeProps=kids(first(c,'p:spPr')),transform=first(shapeProps,'a:xfrm');if(!transform)throw Error('This slide uses inherited object positions that Prism cannot yet preserve.');let box=readTransform(transform);for(const group of [...groups].reverse())box=flattenGroupTransform(group.g,group.child,box);
   if(!['x','y','w','h','rotation'].every(k=>Number.isFinite(box[k]))||box.w<0||box.h<0)throw Error('Invalid slide object transform');box.w=Math.max(.01,box.w);box.h=Math.max(.01,box.h);
   const base={id:crypto.randomUUID(),...box,...(groups.length?{groupPath:groups.map(g=>g.id)}:{})};
   if(type==='p:pic'){const blip=descend(c,'a:blip')[0],src=await image(zip,name,slideRels[attr(blip,'r:embed')]);if(!src)throw Error('This presentation contains an image format Prism cannot preserve.');slide.elements.push({...base,type:'image',src});continue;}
   if(first(shapeProps,'a:custGeom'))throw Error('This presentation contains custom shape geometry Prism cannot yet preserve.');
   if(first(shapeProps,'a:gradFill')||first(shapeProps,'a:blipFill')||first(shapeProps,'a:pattFill'))throw Error('This presentation contains a shape fill Prism cannot yet preserve.');
   const geom=first(shapeProps,'a:prstGeom'),geometry=attr(geom,'prst',type==='p:cxnSp'?'straightConnector1':'rect');if(!shapeGeometries.includes(geometry))throw Error(`Shape geometry “${geometry}” is not supported yet.`);
   if(descend(kids(geom),'a:gd').length)throw Error('This presentation contains adjusted shape geometry Prism cannot yet preserve.');
   const fillNode=first(shapeProps,'a:solidFill'),line=first(shapeProps,'a:ln'),lineColor=slideColor(kids(line),'202331'),lineHidden=first(kids(line),'a:noFill');
   const appearance={geometry,fill:fillNode&&attr(descend(kids(fillNode),'a:alpha')[0],'val','100000')!=='0'?'#'+slideColor(kids(fillNode),'D9D9D9'):'transparent',stroke:lineHidden?undefined:'#'+lineColor,strokeWidth:lineHidden?0:line&&descend(kids(line),'a:solidFill').length?Number(attr(line,'w',12700))/12700:0,dash:attr(first(kids(line),'a:prstDash'),'val','solid'),headArrow:attr(first(kids(line),'a:headEnd'),'type','none'),tailArrow:attr(first(kids(line),'a:tailEnd'),'type','none')};
   const body=first(c,'p:txBody'),paragraphs=all(kids(body),'a:p'),runs=[];for(const [i,p] of paragraphs.entries()){if(i)runs.push({text:'\n'});const defaults=readStyle(first(kids(first(kids(p),'a:pPr')),'a:defRPr'),{fontFamily:'Aptos',fontSize:24,color:'#202331',bold:false,italic:false,underline:false});for(const r of kids(p)){if(['a:r','a:fld'].includes(tag(r)))runs.push({...readStyle(first(kids(r),'a:rPr'),defaults),text:text(kids(first(kids(r),'a:t')))});else if(tag(r)==='a:br')runs.push({...defaults,text:'\n'});}}
   if(body&&runs.some(r=>r.text)){const align=attr(first(kids(paragraphs[0]),'a:pPr'),'algn','l');slide.elements.push({...base,...appearance,type:'text',text:runs.map(r=>r.text).join(''),runs,...Object.fromEntries(Object.entries(runs[0]).filter(([key])=>key!=='text')),align:({l:'left',ctr:'center',r:'right'})[align]??'left'});}
   else slide.elements.push({...base,...appearance,type:'shape'});
  }}await walk(kids(tree));
  const notes=Object.values(slideRels).find(r=>r.type?.endsWith('/notesSlide')&&!r.external);if(notes){const notesXML=await xml(zip,resolve(name,notes.target));slide.notes=descend(notesXML,'p:sp').filter(n=>attr(descend(kids(n),'p:ph')[0],'type')==='body').map(n=>descend(kids(n),'a:t').map(t=>text(kids(t))).join('')).join('\n');}
  f.content.slides.push(slide);
 }
 f.content.activeSlideId=f.content.slides[0].id;return f;
}
module.exports={importWord,importPresentation};

