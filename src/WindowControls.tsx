import {useEffect,useState} from 'react';

export function WindowControls(){
 const [state,setState]=useState({maximized:false,focused:true});
 useEffect(()=>{let alive=true;window.studio.windowState().then(value=>{if(alive)setState(value);});const off=window.studio.onWindowState(setState);return()=>{alive=false;off();};},[]);
 return <div className="app-window-controls" data-focused={state.focused} role="group" aria-label="Window controls">
  <button data-action="close" aria-label="Close window" title="Close" onClick={()=>window.studio.windowControl('close')}><svg viewBox="0 0 12 12"><path d="m3.5 3.5 5 5m0-5-5 5"/></svg></button>
  <button data-action="minimize" aria-label="Minimize window" title="Minimize" onClick={()=>window.studio.windowControl('minimize')}><svg viewBox="0 0 12 12"><path d="M3 6h6"/></svg></button>
  <button data-action="maximize" aria-label={state.maximized?'Restore window':'Maximize window'} title={state.maximized?'Restore':'Maximize'} onClick={()=>window.studio.windowControl('maximize')}><svg viewBox="0 0 12 12"><path d={state.maximized?'M3 3h3v3M9 9H6V6':'M3 7V3h4M9 5v4H5'}/></svg></button>
 </div>;
}
