import {RibbonIcon,hasCommandIcon,ribbonIconName} from './RibbonIcon';
import type { ReactNode } from 'react';
export function Tool({label,active,disabled,onClick,children}:{label:string;active?:boolean;disabled?:boolean;onClick:()=>void;children:ReactNode}) {
  return <button type="button" className={`ed-tool ${active?'is-active':''}`} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onMouseDown={e=>e.preventDefault()} onClick={onClick}>{!hasCommandIcon(children)&&ribbonIconName(label)?<RibbonIcon command={label}/>:children}</button>;
}
export const Divider=()=> <span className="ed-divider" aria-hidden="true"/>;
