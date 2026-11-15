import {decorateRibbonCommands} from './RibbonIcon';
import {useLayoutEffect,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
// ArtCraft puts document quick actions in the title bar, not in a second ribbon row.
export function QuickAccess({children}:{children:ReactNode}){
 const [target,setTarget]=useState<HTMLElement|null>(null);
 useLayoutEffect(()=>setTarget(document.getElementById('office-quick-access')),[]);
 return target?createPortal(decorateRibbonCommands(children),target):<div className="office-quick-access">{decorateRibbonCommands(children)}</div>;
}
