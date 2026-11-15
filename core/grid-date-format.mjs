import {calendarParts,maxSerial} from './gridcraft-calendar.mjs';
export function formatGridDate(value,format,dateSystem=1900){
 if(!Number.isFinite(value)||value<0||value>=maxSerial(dateSystem)+1)return '########';
 if(format==='time'){const seconds=Math.round((value-Math.floor(value))*86400)%86400;return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');}
 const d=calendarParts(value,dateSystem);return `${String(d.year).padStart(4,'0')}-${String(d.month).padStart(2,'0')}-${String(d.day).padStart(2,'0')}`;
}
export function recognizeNumberFormat(format){
 const f=String(format??'').replace(/"[^"]*"|\\.|\[(?![hms]+\])[^\]]*\]/gi,'').toLowerCase();
 if(/[dy]/.test(f))return 'date';if(/[hs]/.test(f)||/\[m\]/.test(f))return 'time';if(f.includes('%'))return 'percent';if(/[$€£¥]/.test(String(format)))return 'currency';return 'general';
}
