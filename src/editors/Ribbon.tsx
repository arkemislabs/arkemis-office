import {decorateRibbonCommands} from './RibbonIcon';
import {FileCommands,useOfficeCommands} from '../OfficeCommands';
import {Children,isValidElement,useId,useState,useEffect,useRef,Fragment,type ReactNode} from 'react';
import {Divider} from './Toolbar';
type RibbonProps={label:string;labels:string[];focusTab:string;focusGroups:number[];homeGroups?:number[];children:ReactNode;extraTabs?:{name:string;content:ReactNode}[];viewContent?:ReactNode;orderedTabs?:string[];contextualTabs?:{name:string;content:ReactNode}[]};
export function Ribbon({label,labels,focusTab,focusGroups,homeGroups,children,extraTabs=[],viewContent,orderedTabs,contextualTabs=[]}:RibbonProps){
 const commands=useOfficeCommands();
 const [selectedTab,setTab]=useState('Home'),[compact,setCompact]=useState(false);const id=useId();const previousTab=useRef('Home');const completed=useRef(commands?.fileActionCompleted);
 const selectTab=(name:string)=>{if(name==='File'&&selectedTab!=='File')previousTab.current=selectedTab;setTab(name);};
 useEffect(()=>{if(commands?.fileActionCompleted!==completed.current){completed.current=commands?.fileActionCompleted;if(selectedTab==='File'){setTab(previousTab.current);document.getElementById(`${id}-${previousTab.current}`)?.focus();}}},[commands?.fileActionCompleted,id,selectedTab]);
 const groups:ReactNode[][]=[[]];
 const visit=(nodes:ReactNode)=>Children.forEach(nodes,node=>{if(!node)return;if(isValidElement<{children?:ReactNode}>(node)&&node.type===Fragment){visit(node.props.children);return;}if(isValidElement(node)&&node.type===Divider){groups.push([]);return;}groups[groups.length-1].push(node);});visit(children);
 const available=[...new Set(['Home',focusTab,...extraTabs.map(t=>t.name),'View',...contextualTabs.map(t=>t.name)])];
 const contentTabs=orderedTabs?[...new Set([...orderedTabs.filter(name=>available.includes(name)),...available])]:available;
 const tabs=commands?['File',...contentTabs.filter(name=>name!=='File')]:contentTabs;
 const tab=tabs.includes(selectedTab)?selectedTab:'Home';
 useEffect(()=>{if(selectedTab!=='File'&&!available.includes(selectedTab))setTab('Home');},[available.join('|'),selectedTab]);
 return <section className={`office-ribbon ${compact?'ribbon-compact':''}`} aria-label={label} onKeyDown={e=>{if(e.key==='Escape'&&tab==='File'){e.preventDefault();setTab(previousTab.current);document.getElementById(`${id}-${previousTab.current}`)?.focus();}}}>
  <div className="ribbon-tabs" role="tablist" aria-label={`${label} tabs`}>{tabs.map((name,index)=><button key={name} id={`${id}-${name}`} role="tab" aria-selected={tab===name} aria-controls={`${id}-panel`} tabIndex={tab===name?0:-1} onClick={()=>selectTab(name)} onKeyDown={e=>{let next=index;if(e.key==='ArrowRight')next=(index+1)%tabs.length;else if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;e.preventDefault();selectTab(tabs[next]);document.getElementById(`${id}-${tabs[next]}`)?.focus();}}>{name}</button>)}</div>
  <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className="ed-toolbar ribbon-panel">
   {decorateRibbonCommands(tab==='File'?<FileCommands onBack={()=>{setTab(previousTab.current);document.getElementById(`${id}-${previousTab.current}`)?.focus();}}/>: [...extraTabs,...contextualTabs].find(t=>t.name===tab)?.content??(tab==='View'?<><div className="ribbon-group" role="group" aria-label="Ribbon display"><div className="ribbon-commands"><button className="ed-text-tool" aria-pressed={!compact} onClick={()=>setCompact(false)}>Classic ribbon</button><button className="ed-text-tool" aria-pressed={compact} onClick={()=>setCompact(true)}>Compact ribbon</button></div><span className="ribbon-group-label">Ribbon display</span></div>{viewContent}</>:groups.map((nodes,index)=>nodes.length&&(tab==='Home'?(!homeGroups||homeGroups.includes(index)):focusGroups.includes(index))?<div className="ribbon-group" role="group" aria-label={labels[index]??'Context tools'} key={index}><div className="ribbon-commands">{nodes}</div><span className="ribbon-group-label">{labels[index]??'Context tools'}</span></div>:null)))}
  </div>
 </section>;
}
