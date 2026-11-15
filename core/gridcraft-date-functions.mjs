// Source-to-source translation of GridCraft crates/functions/src/date.rs.
// Revision 146161b4b450a56e5e59a083ba0478582d1e602b. MIT notice in gridcraft-text-family.mjs.
// Calendar arithmetic uses UTC; injected clock/dateSystem make calculations deterministic.
import {dateFail as fail,mod,maxSerial,isLeap,monthDays,serialFromYmd,calendarParts,parseDateTimeText,formulaNumber} from './gridcraft-calendar.mjs';
export const dateFunctionNames=new Set('DATE TIME YEAR MONTH DAY HOUR MINUTE SECOND NOW TODAY WEEKDAY WEEKNUM ISOWEEKNUM EDATE EOMONTH DATEDIF DATEVALUE TIMEVALUE DAYS DAYS360 NETWORKDAYS NETWORKDAYS.INTL WORKDAY WORKDAY.INTL YEARFRAC'.split(' '));
function weekendMask(v){
 if(v===undefined)return [true,false,false,false,false,false,true];if(typeof v==='string'){if(!/^[01]{7}$/.test(v))fail();const mask=Array(7).fill(false);Array.from(v).forEach((c,i)=>mask[(i+1)%7]=c==='1');return mask;}
 const k=Math.trunc(formulaNumber(v)),m=Array(7).fill(false);if(k>=1&&k<=7){m[(k+5)%7]=true;m[(k+6)%7]=true;}else if(k>=11&&k<=17)m[k-11]=true;else fail('#NUM!');return m;
}
// Binary counts keep a long consecutive holiday calendar from becoming quadratic.
const lowerBound=(a,x)=>{let lo=0,hi=a.length;while(lo<hi){const mid=(lo+hi)>>>1;if(a[mid]<x)lo=mid+1;else hi=mid;}return lo;};
const lastFeb=d=>d.month===2&&d.day===monthDays(d.year,2);
function days360(a,b,european){let d1=a.day,d2=b.day;if(european){d1=Math.min(30,d1);d2=Math.min(30,d2);}else{if(d1===31||lastFeb(a))d1=30;if(d2===31&&d1>=30)d2=30;}return (b.year-a.year)*360+(b.month-a.month)*30+d2-d1;}
export function dateFunction(name,a,context={}){
 const system=context.dateSystem===1904?1904:1900,limit=maxSerial(system),arity=(min,max=min)=>{if(a.length<min||a.length>max)fail();},num=v=>formulaNumber(v,system),int=v=>Math.trunc(num(v));
 const serial=v=>{const n=num(v);if(n<0||n>=limit+1)fail('#NUM!');return n;},day=v=>Math.floor(serial(v)),dt=s=>calendarParts(s,system),ymd=(y,m,d)=>serialFromYmd(y,m,d,system)??fail('#NUM!'),weekday=s=>mod(s+(system===1904?5:6),7);
 const isoWeek=s=>{const iso=(weekday(s)+6)%7+1,thursday=s-iso+4,first=system===1904?0:1,jan1=thursday<first?first-365:ymd(dt(thursday).year,1,1);return Math.floor((thursday-jan1)/7)+1;};
 switch(name){
 case 'DATE':{arity(3);const [y,m,d]=a.map(int);if(y<0||y>=10000||Math.abs(m)>1e6||Math.abs(d)>1e8)fail('#NUM!');return ymd(y,m,d);}
 case 'TIME':{arity(3);const [h,m,s]=a.map(int);if(h>32767||m>32767||s>32767)fail('#NUM!');const total=h*3600+m*60+s;if(total<0)fail('#NUM!');return mod(total,86400)/86400;}
 case 'YEAR':case 'MONTH':case 'DAY':arity(1);return dt(day(a[0]))[name.toLowerCase()];
 case 'HOUR':case 'MINUTE':case 'SECOND':{arity(1);const s=serial(a[0]),secs=Math.round((s-Math.floor(s))*86400)%86400;return name==='HOUR'?Math.floor(secs/3600):name==='MINUTE'?Math.floor(secs/60)%60:secs%60;}
 case 'NOW':case 'TODAY':{arity(0);const s=(context.nowSerial??(25569+Date.now()/86400000))-(system===1904?1462:0);return name==='TODAY'?Math.floor(s):s;}
 case 'WEEKDAY':{arity(1,2);const wd=weekday(day(a[0])),t=int(a[1]??1);if(t===1||t===17)return wd+1;if(t===2||t===11)return (wd+6)%7+1;if(t===3)return (wd+6)%7;if(t>=12&&t<=16)return (wd+7-(t-10))%7+1;fail('#NUM!');break;}
 case 'WEEKNUM':case 'ISOWEEKNUM':{arity(1,name==='WEEKNUM'?2:1);const s=day(a[0]),t=name==='ISOWEEKNUM'?21:int(a[1]??1);if(t===21)return isoWeek(s);const start=t===1||t===17?0:t===2||t===11?1:t>=12&&t<=16?t-10:fail('#NUM!');const jan1=serialFromYmd(dt(s).year,1,1,system)??Math.min(s,1),offset=(weekday(jan1)+7-start)%7;return Math.floor((s-jan1+offset)/7)+1;}
 case 'EDATE':case 'EOMONTH':{arity(2);const d=dt(day(a[0])),m=int(a[1]);if(Math.abs(m)>200000)fail('#NUM!');const total=d.year*12+d.month-1+m,y=Math.floor(total/12),mo=mod(total,12)+1;if(y<1900||y>9999)fail('#NUM!');return ymd(y,mo,name==='EDATE'?Math.min(d.day,monthDays(y,mo)):monthDays(y,mo));}
 case 'DATEDIF':{arity(3);const s=day(a[0]),e=day(a[1]);if(s>e)fail('#NUM!');if(Array.isArray(a[2]))fail();const unit=String(a[2]).toUpperCase(),d1=dt(s),d2=dt(e),months=(d2.year-d1.year)*12+d2.month-d1.month-Number(d2.day<d1.day);
 if(unit==='D')return e-s;if(unit==='M')return months;if(unit==='Y')return Math.trunc(months/12);if(unit==='YM')return months%12;if(unit==='MD'){if(d2.day>=d1.day)return d2.day-d1.day;return monthDays(d2.month===1?d2.year-1:d2.year,d2.month===1?12:d2.month-1)-d1.day+d2.day;}if(unit==='YD'){const later=d1.month>d2.month||(d1.month===d2.month&&d1.day>d2.day),y=d2.year-Number(later);return e-ymd(y,d1.month,Math.min(d1.day,monthDays(y,d1.month)));}fail('#NUM!');break;}
 case 'DATEVALUE':case 'TIMEVALUE':{arity(1);if(typeof a[0]!=='string')fail();const parsed=parseDateTimeText(a[0],system);if(!parsed||(name==='DATEVALUE'&&parsed.kind==='time'))fail();return name==='DATEVALUE'?Math.floor(parsed.value):parsed.value-Math.floor(parsed.value);}
 case 'DAYS':arity(2);return day(a[0])-day(a[1]);
 case 'DAYS360':arity(2,3);return days360(dt(day(a[0])),dt(day(a[1])),num(a[2]??0)!==0);
 case 'NETWORKDAYS':case 'NETWORKDAYS.INTL':case 'WORKDAY':case 'WORKDAY.INTL':{
  const intl=name.endsWith('.INTL'),work=name.startsWith('WORKDAY');arity(2,intl?4:3);const s=day(a[0]),mask=weekendMask(intl?a[2]:undefined),raw=a[intl?3:2],holidays=[...new Set((raw===undefined?[]:Array.isArray(raw)?raw:[raw]).filter(v=>v!==''&&v!==null&&v!==undefined).map(day))].sort((a,b)=>a-b),perWeek=mask.filter(v=>!v).length;
  const workingHolidays=holidays.filter(h=>!mask[weekday(h)]),holidayCount=(lo,hi)=>lowerBound(workingHolidays,hi+1)-lowerBound(workingHolidays,lo);
  if(!work){const e=day(a[1]),lo=Math.min(s,e),hi=Math.max(s,e),weeks=Math.floor((hi-lo+1)/7);let count=weeks*perWeek;for(let d=lo+weeks*7;d<=hi;d++)if(!mask[weekday(d)])count++;return (count-holidayCount(lo,hi))*(s<=e?1:-1);}
  const days=int(a[1]);if(Math.abs(days)>1e7)fail('#NUM!');if(!perWeek)fail();if(!days)return s;const dir=Math.sign(days);let cur=s,rem=Math.abs(days);
  while(rem>0){const weeks=Math.floor((rem-1)/perWeek);let next=cur+dir*7*weeks,left=rem-weeks*perWeek;while(left>0){next+=dir;if(!mask[weekday(next)])left--;}const lo=dir>0?cur+1:next,hi=dir>0?next:cur-1;rem=holidayCount(lo,hi);cur=next;if(cur<0||cur>limit)fail('#NUM!');}return cur;
 }
 case 'YEARFRAC':{
  arity(2,3);const aa=day(a[0]),bb=day(a[1]),s=Math.min(aa,bb),e=Math.max(aa,bb),d1=dt(s),d2=dt(e),days=e-s,basis=int(a[2]??0);
  if(basis===2)return days/360;if(basis===3)return days/365;if(basis===4)return days360(d1,d2,true)/360;
  if(basis===0){let a=d1.day,b=d2.day;if(lastFeb(d1)&&lastFeb(d2))b=30;if(lastFeb(d1)||a===31)a=30;if(a===30&&b===31)b=30;return ((d2.year-d1.year)*360+(d2.month-d1.month)*30+b-a)/360;}
  if(basis!==1)fail('#NUM!');const within=d1.year===d2.year||(d2.year===d1.year+1&&(d1.month>d2.month||(d1.month===d2.month&&d1.day>=d2.day)));
  if(within){let feb29=false;for(let y=d1.year;y<=d2.year;y++){const f=isLeap(y)?serialFromYmd(y,2,29,system):null;if(f!==null&&f>=s&&f<=e)feb29=true;}return days/((d1.year===d2.year&&isLeap(d1.year))||feb29||(d2.month===2&&d2.day===29)?366:365);}
  const years=d2.year-d1.year+1,span=(serialFromYmd(d2.year+1,1,1,system)??e+1)-(serialFromYmd(d1.year,1,1,system)??s);return days/(span/years);
 }
 default:fail('#NAME?');
 }
}
