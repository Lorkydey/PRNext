import {createElement,Fragment,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {displayAttributeName,displayBranch,displayKey,displayList,displayProps,displayScope,displayText,displayValue,renderPresentationDisplay} from './presentation-display.mjs';

const SVG='http://www.w3.org/2000/svg';
const EMPTY=Object.freeze([]);
const normalizedText=value=>value.replace(/\r\n?/g,'\n').replace(/\u0000/g,'\ufffd');
function first(record) {
  if(!record)return null;
  if(record.node)return record.node;
  if(record.child)return first(record.child);
  for(const child of record.children||record.rows||[]){const node=first(child);if(node)return node;}
  return null;
}
function remove(record) {
  if(!record)return;
  if(record.node){record.node.remove();return;}
  if(record.child)remove(record.child);
  for(const child of record.children||record.rows||[])remove(child);
}
function attributes(ir,scope) {
  if(!ir[2].length)return EMPTY;
  return ir[2].filter(a=>a[0]!=='key').map(([name,ref,css])=>[displayAttributeName(name),displayValue(css||ref,scope)]);
}
function setAttribute(node,name,value) {
  if(value===null||value===undefined||typeof value==='boolean'||name==='style'&&value==='')node.removeAttribute(name);
  else node.setAttribute(name,String(value));
}
function updateAttributes(ir,record,scope) {
  const source=ir[2];let index=0,compatible=true;
  for(const[name]of source)if(name!=='key'){
    if(record.attrs[index]?.[0]!==displayAttributeName(name))compatible=false;
    index++;
  }
  compatible&&=index===record.attrs.length;
  if(compatible){
    index=0;
    for(const[name,ref,css]of source)if(name!=='key'){
      const previous=record.attrs[index++],value=displayValue(css||ref,scope);
      if(previous[1]!==value){setAttribute(record.node,previous[0],value);previous[1]=value;}
    }
    return;
  }
  const next=attributes(ir,scope);
  for(const[name,value]of next)if(record.attrs.find(a=>a[0]===name)?.[1]!==value)setAttribute(record.node,name,value);
  for(const[name]of record.attrs)if(!next.some(a=>a[0]===name))record.node.removeAttribute(name);
  record.attrs=next;
}
function count(record) {
  if(record.node)return 1;
  if(record.kind==='t')return 0;
  if(record.kind==='r')return record.rows.length;
  if(record.child)return count(record.child);
  return record.children.reduce((n,child)=>n+count(child),0);
}
function consumeSeparators(cursor,removed) {
  while(cursor.node?.nodeType===8&&cursor.node.data==='') {
    removed.push(cursor.node);cursor.node=cursor.node.nextSibling;
  }
}
function adopt(ir,scope,cursor,removed) {
  if(--scope.remaining<0)throw new RangeError('Display adoption budget');
  consumeSeparators(cursor,removed);
  if(ir[0]==='t'){
    const value=displayText(displayValue(ir[1],scope));
    if(value==='')return{kind:'t',node:null,value};
    const node=cursor.node;
    if(node?.nodeType!==3||node.nodeValue!==normalizedText(value))throw new Error('Display text shape changed');
    cursor.node=node.nextSibling;return{kind:'t',node,value};
  }
  if(ir[0]==='e'){
    const node=cursor.node;
    if(node?.nodeType!==1||node.localName!==ir[1]||!!ir[5]!== (node.namespaceURI===SVG))throw new Error('Display element shape changed');
    cursor.node=node.nextSibling;
    const childrenCursor={node:node.firstChild};
    const children=ir[3].map(child=>adopt(child,scope,childrenCursor,removed));
    consumeSeparators(childrenCursor,removed);if(childrenCursor.node)throw new Error('Unexpected display children');
    return{kind:'e',node,attrs:attributes(ir,scope),children,reactKey:ir[4]?displayValue(ir[4],scope):undefined};
  }
  if(ir[0]==='f')return{kind:'f',children:ir[1].map(child=>adopt(child,scope,cursor,removed))};
  if(ir[0]==='c')return{kind:'c',child:adopt(displayBranch(ir,scope),scope,cursor,removed)};
  const list=displayList(ir,scope),rows=[];
  for(let i=0;i<list.count;i++){
    scope.offsets[ir[2]]=list.start+i*list.width;
    const key=displayKey(ir[5],scope,i),row=adopt(ir[4],scope,cursor,removed);
    row.listKey=key;rows.push(row);
  }
  return{kind:'r',rows};
}
function position(node,parent,before) {
  if(node.parentNode!==parent||node.nextSibling!==before)parent.insertBefore(node,before);
}
function retainSelection(root) {
  const document=root.ownerDocument,focused=document.activeElement;
  const selection=document.defaultView?.getSelection();
  const inside=selection?.anchorNode&&selection.focusNode&&root.contains(selection.anchorNode)&&root.contains(selection.focusNode);
  const saved=inside?{anchor:selection.anchorNode,anchorOffset:selection.anchorOffset,focus:selection.focusNode,focusOffset:selection.focusOffset}:null;
  const focusInside=focused&&root.contains(focused);
  return()=>{
    // insertBefore can blur a moved element. React normally restores selection
    // around its mutation phase; our opaque descendants move in a layout effect.
    if(focusInside&&focused.isConnected&&root.contains(focused)&&document.activeElement!==focused)focused.focus({preventScroll:true});
    if(saved&&saved.anchor.isConnected&&saved.focus.isConnected&&root.contains(saved.anchor)&&root.contains(saved.focus)){
      const size=node=>node.nodeType===3?node.nodeValue.length:node.childNodes.length;
      selection.setBaseAndExtent(saved.anchor,Math.min(saved.anchorOffset,size(saved.anchor)),saved.focus,Math.min(saved.focusOffset,size(saved.focus)));
    }
  };
}
function patchChildren(instructions,previous,scope,parent,before) {
  if(parent.childNodes.length!==previous.reduce((n,child)=>n+count(child),0))throw new Error('Display ownership changed');
  for(let i=instructions.length;i<previous.length;i++)remove(previous[i]);
  const children=previous;children.length=instructions.length;
  for(let i=instructions.length-1;i>=0;i--){
    children[i]=patch(instructions[i],previous[i],scope,parent,before);
    before=first(children[i])||before;
  }
  return children;
}
function patch(ir,previous,scope,parent,before) {
  if(--scope.remaining<0)throw new RangeError('Display update budget');
  if(previous?.node&&previous.node.parentNode!==parent)throw new Error('Display ownership changed');
  if(previous&&previous.kind!==ir[0]){remove(previous);previous=undefined;}
  if(ir[0]==='t'){
    const value=displayText(displayValue(ir[1],scope));
    const record=previous||{kind:'t',node:null,value:''};
    if(value===''){record.node?.remove();record.node=null;}
    else{
      if(!record.node)record.node=parent.ownerDocument.createTextNode(value);
      else if(record.value!==value)record.node.nodeValue=value;
      position(record.node,parent,before);
    }
    record.value=value;return record;
  }
  if(ir[0]==='e'){
    const reactKey=ir[4]?displayValue(ir[4],scope):undefined;
    if(previous&&(previous.node.localName!==ir[1]||previous.reactKey!==reactKey||!!ir[5]!== (previous.node.namespaceURI===SVG))){remove(previous);previous=undefined;}
    const record=previous||{kind:'e',node:ir[5]?parent.ownerDocument.createElementNS(SVG,ir[1]):parent.ownerDocument.createElement(ir[1]),attrs:[],children:[],reactKey};
    updateAttributes(ir,record,scope);
    record.children=patchChildren(ir[3],record.children,scope,record.node,null);
    position(record.node,parent,before);return record;
  }
  if(ir[0]==='f'){
    const record=previous||{kind:'f',children:[]};
    record.children=patchChildren(ir[1],record.children,scope,parent,before);return record;
  }
  if(ir[0]==='c'){
    const record=previous||{kind:'c',child:null};
    record.child=patch(displayBranch(ir,scope),record.child,scope,parent,before);return record;
  }
  const list=displayList(ir,scope),record=previous||{kind:'r',rows:[]};
  let ordered=record.rows.length===list.count;
  for(let i=0;ordered&&i<list.count;i++){
    scope.offsets[ir[2]]=list.start+i*list.width;
    ordered=record.rows[i].listKey===displayKey(ir[5],scope,i);
  }
  const old=ordered?null:new Map(record.rows.map(row=>[row.listKey,row])),rows=record.rows;
  rows.length=list.count;
  for(let i=list.count-1;i>=0;i--){
    scope.offsets[ir[2]]=list.start+i*list.width;
    const key=displayKey(ir[5],scope,i),row=patch(ir[4],ordered?rows[i]:old.get(key),scope,parent,before);
    old?.delete(key);row.listKey=key;rows[i]=row;before=first(row)||before;
  }
  if(old)for(const row of old.values())remove(row);
  record.rows=rows;return record;
}

// Ordinary React recovery reads the same checked plan/packet. It needs neither
// another compiled JSX copy nor reconstruction of the original row arrays.
export function renderPresentationReact(plan,packet,literals) {
  'use no memo';
  const scope=displayScope(packet,literals);scope.reader.range(0,plan.width);
  function render(ir) {
    if(ir[0]==='t')return displayValue(ir[1],scope);
    if(ir[0]==='e')return createElement(ir[1],{...displayProps(ir[2],scope),...(ir[4]?{key:displayValue(ir[4],scope)}:{})},...ir[3].map(render));
    if(ir[0]==='f')return createElement(Fragment,null,...ir[1].map(render));
    if(ir[0]==='c')return render(displayBranch(ir,scope));
    const list=displayList(ir,scope),rows=new Array(list.count);
    for(let i=0;i<list.count;i++){scope.offsets[ir[2]]=list.start+i*list.width;rows[i]=render(ir[4]);}
    return rows;
  }
  return render(plan.root);
}

/** React owns the real host root and attributes. Its opaque inner HTML is
 * identical on SSR and hydration. Only descendants of this checked, pure root
 * are adopted/patched in a layout effect; no React-managed child fibers exist.
 * The baseline HTML stays stable while this ownership mode is active. Switching
 * to/from ordinary output resets it synchronously, before the next commit.
 */
export function createPresentationDom(plan,writer) {
  'use no memo';
  return function Presentation(props) {
    'use no memo';
    const node=useRef(null),records=useRef(null);
    const [failed,setFailed]=useState(false);
    const data=props.__prnextPresentation,literals=props.__prnextLiterals;
    const prepared=useMemo(()=>{
      if(data===undefined||failed)return null;
      try{return renderPresentationDisplay(plan,data,literals,writer);}catch{return null;}
    },[data,literals,failed]);
    const active=!!prepared&&!failed;
    const [baseline,setBaseline]=useState(()=>({active,html:prepared?.html||''}));
    if(baseline.active!==active)setBaseline({active,html:prepared?.html||''});
    useLayoutEffect(()=>{
      if(!active){records.current=null;return;}
      try{
        const scope=displayScope(data,literals),root=node.current;
        if(!records.current){
          const cursor={node:root.firstChild},removed=[];
          const children=plan.root[3].map(ir=>adopt(ir,scope,cursor,removed));
          consumeSeparators(cursor,removed);if(cursor.node)throw new Error('Unexpected display root contents');
          for(const separator of removed)separator.remove();
          records.current=children;
        }else{
          const restore=retainSelection(root);
          try{records.current=patchChildren(plan.root[3],records.current,scope,root,null);}finally{restore();}
        }
      }catch{records.current=null;setFailed(true);}
    },[active,data,literals]);
    if(active)return createElement(plan.root[1],{...prepared.props,ref:node,dangerouslySetInnerHTML:{__html:baseline.active===active?baseline.html:prepared.html}});
    if(data===undefined)return props.__prnextOrdinary;
    return renderPresentationReact(plan,data,literals);
  };
}
