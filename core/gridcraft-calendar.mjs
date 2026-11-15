// Source translation: GridCraft crates/core/src/date.rs and parse.rs.
// Pinned source and full MIT notice in gridcraft-text-family.mjs.
export const dateFail=(code='#VALUE!')=>{throw new Error(code);};
export const mod=(n,d)=>((n%d)+d)%d;
export const maxSerial=(system=1900)=>2958465-(system===1904?1462:0);
export const isLeap=y=>y%4===0&&(y%100!==0||y%400===0);
export const monthDays=(y,m,fake=false)=>m===2?(fake&&y===1900?29:isLeap(y)?29:28):[4,6,9,11].includes(m)?30:31;
export function serialFromYmd(year,month,day,system=1900){
 let y=year>=0&&year<1900?year+1900:year;y+=Math.floor((month-1)/12);const m=mod(month-1,12)+1;
 if(!Number.isSafeInteger(y)||y<(system===1904?1904:1900)||y>9999)return null;
 const first=Date.UTC(y,m-1,1)/86400000+(system===1904?24107:25569)-(system!==1904&&y===1900&&m<=2?1:0),s=first+day-1;
 return Number.isSafeInteger(s)&&s>=0&&s<=maxSerial(system)?s:null;
}
export function calendarParts(serial,system=1900){
 if(!Number.isFinite(serial)||serial<0||serial>=maxSerial(system)+1)dateFail('#NUM!');
 const s=Math.floor(serial);if(system!==1904&&s===0)return {year:1900,month:1,day:0};if(system!==1904&&s===60)return {year:1900,month:2,day:29};
 const d=new Date((s-(system===1904?24107:25569)+(system!==1904&&s<60?1:0))*86400000);return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()};
}
const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
const asciiNumber=(s,fraction=false)=>new RegExp(fraction?'^\\d+(?:\\.\\d+)?$':'^\\d+$').test(s)&&Number.isFinite(Number(s))?Number(s):null;
const expandYear=s=>s.length<=2?(Number(s)<30?2000:1900)+Number(s):Number(s);
const namedMonth=s=>s.length>=3?months.findIndex(m=>m.startsWith(s.toLowerCase()))+1:0;
function validDate(y,m,d,system){if(y<1900||m<1||m>12||d<1||d>monthDays(y,m,system!==1904))return null;return serialFromYmd(y,m,d,system);}
export function parseDateText(text,system=1900,year=new Date().getUTCFullYear()){
 const t=text.trim().replace(/,+$/,''),parts=t.split(/[\/.-]/).map(p=>p.trim());let y,m,d;
 if(parts.length===3){const [a,b,c]=parts;
  if(a.length===4&&[a,b,c].every(x=>asciiNumber(x)!==null)){[y,m,d]=parts.map(Number);}
  else if([a,b,c].every(x=>asciiNumber(x)!==null)){[m,d]=[Number(a),Number(b)];y=expandYear(c);}
  else if(asciiNumber(a)!==null&&namedMonth(b)&&asciiNumber(c)!==null){d=Number(a);m=namedMonth(b);y=expandYear(c);}
 }else if(parts.length===2){const [a,b]=parts;
  if(asciiNumber(a)!==null&&asciiNumber(b)!==null){m=Number(a);if(Number(b)<=31){d=Number(b);y=year;}else if(b.length===4){y=Number(b);d=1;}}
  else if(asciiNumber(a)!==null&&namedMonth(b)){d=Number(a);m=namedMonth(b);y=year;}
  else if(namedMonth(a)&&asciiNumber(b)!==null){m=namedMonth(a);y=expandYear(b);d=1;}
 }
 if(y!==undefined)return validDate(y,m,d,system);
 const w=t.split(/[ ,]/).filter(Boolean);if(w.length===3&&asciiNumber(w[2])!==null){y=expandYear(w[2]);if(namedMonth(w[0])&&asciiNumber(w[1])!==null){m=namedMonth(w[0]);d=Number(w[1]);}else if(asciiNumber(w[0])!==null&&namedMonth(w[1])){d=Number(w[0]);m=namedMonth(w[1]);}else return null;return validDate(y,m,d,system);}return null;
}
export function parseTimeText(text){
 let t=text.trim().toLowerCase(),ampm=null;const suffix=/(am|pm|a|p)$/.exec(t);if(suffix){ampm=suffix[1][0]==='p';t=t.slice(0,-suffix[1].length).trim();}
 const p=t.split(':');if(p.length>3||(p.length===1&&ampm===null))return null;
 let h=asciiNumber(p[0]),m=p.length>1?asciiNumber(p[1]):0,s=p.length>2?asciiNumber(p[2],true):0;if(h===null||m===null||s===null||m>=60||s>=60)return null;
 if(ampm!==null){if(h>12)return null;if(h===12)h=0;if(ampm)h+=12;}else if(h>=10000)return null;return (h*3600+m*60+s)/86400;
}
export function parseDateTimeText(text,system=1900){
 const t=text.trim();let n=parseTimeText(t);if(n!==null)return {value:n,kind:'time'};n=parseDateText(t,system);if(n!==null)return {value:n,kind:'date'};
 for(let i=t.indexOf(' ');i>=0;i=t.indexOf(' ',i+1)){const tail=t.slice(i+1);if(tail.length>36||!/^\d/.test(tail)||!tail.includes(':'))continue;const date=parseDateText(t.slice(0,i),system),time=parseTimeText(tail);if(date!==null&&time!==null)return {value:date+time,kind:'datetime'};}return null;
}
function parsePlain(text){
 let s=text,neg=false,currency=false,percent=false;if(s[0]==='-'){neg=true;s=s.slice(1).trimStart();}else if(s[0]==='+')s=s.slice(1).trimStart();
 if(s[0]==='$'){currency=true;s=s.slice(1).trimStart();if(!neg&&s[0]==='-'){neg=true;s=s.slice(1);}}
 if(s.endsWith('%')){percent=true;s=s.slice(0,-1).trimEnd();}if(!s||(currency&&percent))return null;
 if(s.includes(',')){const dot=s.indexOf('.'),whole=dot<0?s:s.slice(0,dot),frac=dot<0?'':s.slice(dot);const g=whole.split(',');if(!g[0]||g[0].length>3||g.slice(1).some(x=>x.length!==3))return null;s=g.join('')+frac;}
 if(!/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s))return null;let n=Number(s);if(!Number.isFinite(n))return null;if(percent)n/=100;return neg?-n:n;
}
function parseFraction(t){const m=/^(-?\d+) +(\d+)\/(\d+)$/.exec(t);if(!m)return null;const w=Number(m[1]),a=Number(m[2]),b=Number(m[3]);if(![w,a,b].every(Number.isFinite)||!b)return null;const n=Math.abs(w)+a/b;return Number.isFinite(n)?(m[1][0]==='-'?-n:n):null;}
export function parseNumberText(text,system=1900){
 const t=String(text).trim();if(!t)return null;const m=/^(\$\s*)?\((.*)\)\s*(%)?$/.exec(t);
 if(m){const body=(m[1]?'$':'')+m[2].trim()+(m[3]??'');if(/^[+\-(]/.test(body.replace(/^\$\s*/,'')))return null;const n=parsePlain(body)??parseFraction(body);return n===null?null:-n;}
 return parsePlain(t)??parseFraction(t)??parseDateTimeText(t,system)?.value??null;
}
export function formulaNumber(v,system=1900){if(Array.isArray(v))dateFail();if(v===''||v===null||v===undefined)return 0;const n=typeof v==='string'?parseNumberText(v,system):Number(v);return n!==null&&Number.isFinite(n)?n:dateFail();}
