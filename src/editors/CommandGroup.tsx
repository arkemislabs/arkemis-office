import {decorateRibbonCommands} from './RibbonIcon';
import type {ReactNode} from 'react';
export function CommandGroup({label,children}:{label:string;children:ReactNode}){return <div className="ribbon-group" role="group" aria-label={label}><div className="ribbon-commands">{decorateRibbonCommands(children)}</div><span className="ribbon-group-label">{label}</span></div>;}
