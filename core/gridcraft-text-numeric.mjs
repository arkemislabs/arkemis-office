// Translation of GridCraft functions/src/text.rs numeric text and util.rs rounding.
// Full MIT notice and source revision: gridcraft-text-family.mjs.
import {parseNumberText,formulaNumber,dateFail as fail} from './gridcraft-calendar.mjs';
export const numericTextNames=new Set('VALUE NUMBERVALUE FIXED DOLLAR USDOLLAR BAHTTEXT'.split(' '));
export function roundHalfAway(x,digits){
 if(!Number.isFinite(x)||x===0)return x;const [mant,exp]=Math.abs(x).toExponential(14).split('e');const d=mant.replace('.','').split('').map(Number),e=Number(exp),keep=e+1+Math.max(-400,Math.min(400,digits));
 if(keep>=d.length)return Number(x.toPrecision(15));if(keep<0)return 0;const up=d[keep]>=5;d.length=keep;let exponent=e+1;
 if(up){let i=keep;while(true){if(i===0){d.unshift(1);exponent++;break;}i--;if(d[i]===9)d[i]=0;else{d[i]++;break;}}}if(!d.length)return 0;return Math.sign(x)*Number('0.'+d.join('')+'e'+exponent);
}
// Rust decimal formatting works above JS toFixed's 100-place ceiling. Convert the
// exact f64 significand to a decimal integer, rounding ties to even like Rust fmt.
export function fixedDecimal(x,places){
 const b=new ArrayBuffer(8),view=new DataView(b);view.setFloat64(0,Math.abs(x));const bits=view.getBigUint64(0),exponent=Number((bits>>52n)&2047n),fraction=bits&((1n<<52n)-1n);let n=exponent?fraction+(1n<<52n):fraction;const shift=(exponent?exponent-1023:1-1023)-52;n*=10n**BigInt(places);
 if(shift>=0)n<<=BigInt(shift);else{const den=1n<<BigInt(-shift),q=n/den,r=n%den;n=q+(r*2n>den||(r*2n===den&&q%2n===1n)?1n:0n);}
 let s=n.toString();if(!places)return s;s=s.padStart(places+1,'0');return s.slice(0,-places)+'.'+s.slice(-places);
}
const thaiDigits=['ศูนย์','หนึ่ง','สอง','สาม','สี่','ห้า','หก','เจ็ด','แปด','เก้า'],thaiPlaces=['','สิบ','ร้อย','พัน','หมื่น','แสน'];
function thaiGroup(d,after){const higher=after||d.slice(0,-1).some(n=>n!==0);return d.map((n,i)=>{const p=d.length-1-i;if(!n)return '';if(p===0&&n===1&&higher)return 'เอ็ด';if(p===1&&n===1)return 'สิบ';if(p===1&&n===2)return 'ยี่สิบ';return thaiDigits[n]+thaiPlaces[p];}).join('');}
function thaiNumber(s){const d=s.replace(/^0+/,'').split('').map(Number);if(!d.length)return thaiDigits[0];let start=0,len=d.length%6||6,out='';while(start<d.length){out+=thaiGroup(d.slice(start,start+len),start>0);start+=len;len=6;if(start<d.length)out+='ล้าน';}return out;}
export function numericTextFunction(name,a,context={}){
 const arity=(min,max=min)=>{if(a.length<min||a.length>max)fail();};const text=v=>Array.isArray(v)?fail():String(v??'');const num=v=>formulaNumber(v,context.dateSystem);
 if(name==='VALUE'){arity(1);if(context.blankArguments?.[0])return 0;if(typeof a[0]==='number')return a[0];if(typeof a[0]!=='string')fail();return parseNumberText(a[0],context.dateSystem)??fail();}
 if(name==='NUMBERVALUE'){
  arity(1,3);const decimal=Array.from(text(a[1]??'.'))[0],group=Array.from(text(a[2]??','))[0];if(!decimal||!group||decimal===group)fail();let body=text(a[0]).replace(/\s/gu,'');if(!body)return 0;let percent=0;while(body.endsWith('%')){body=body.slice(0,-1);percent++;}let out='',seen=false;for(const c of body){if(c===decimal){if(seen)fail();seen=true;out+='.';}else if(c===group){if(seen)fail();}else if(c==='.'||c===',')fail();else out+=c;}let n=parseNumberText(out,context.dateSystem);if(n===null)fail();for(let i=0;i<percent;i++)n/=100;return n;
 }
 if(name==='BAHTTEXT'){
  arity(1);const x=roundHalfAway(num(a[0]),2);if(!Number.isFinite(x))fail('#NUM!');const [whole,frac]=fixedDecimal(x,2).split('.'),baht=/[1-9]/.test(whole),satang=/[1-9]/.test(frac);let out=x<0&&(baht||satang)?'ลบ':'';if(baht||!satang)out+=thaiNumber(whole)+'บาท';return out+(satang?thaiNumber(frac)+'สตางค์':'ถ้วน');
 }
 arity(1,name==='FIXED'?3:2);const digits=Math.trunc(num(a[1]??2));if(digits>127)fail();const d=Math.max(-308,digits),r=roundHalfAway(num(a[0]),d);if(!Number.isFinite(r)||Math.abs(r)>=1e300)fail('#NUM!');const [whole,fraction]=fixedDecimal(r,Math.max(0,d)).split('.'),commas=name!=='FIXED'||!num(a[2]??0),body=(commas?whole.replace(/\B(?=(\d{3})+(?!\d))/g,','):whole)+(fraction!==undefined?'.'+fraction:'');return name==='FIXED'?(r<0?'-':'')+body:r<0?'($'+body+')':'$'+body;
}
