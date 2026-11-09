import * as t from '@babel/types';
import {presentationSvgTags} from './presentation-svg.mjs';
import {displayAttributeName} from '../runtime/presentation-display.mjs';

const htmlTags=new Set('div span p section article main aside header footer nav ul ol li table thead tbody tfoot tr td th h1 h2 h3 h4 h5 h6 b strong i em small pre code blockquote dl dt dd s u mark sup sub'.split(' '));
const blockTags=new Set('div p section article main aside header footer nav ul ol li table h1 h2 h3 h4 h5 h6 pre blockquote dl'.split(' '));
const fail=()=>{throw new Error('DOM plan requires a verified intrinsic tree');};

function compileWriter(plan) {
  let sequence=0;const fresh=()=>`p${sequence++}`,statements=['let html="",adjacent=false,budget=100000;const reader=scope.reader,literals=scope.literals;'];
  const append=code=>statements.push(`html+=${code};if(html.length>4194304)throw new RangeError('Display HTML budget');`);
  const value=(ref,offsets)=>ref[0]==='l'?`literals[${ref[1]}]`:ref[0]==='s'?JSON.stringify(ref[1]):`reader.at(${offsets[ref[1]]}+${ref[2]})`;
  function emit(ir,offsets){
    statements.push(`if(--budget<0)throw new RangeError('Display node budget');`);
    if(ir[0]==='t'){
      const v=fresh();statements.push(`{const ${v}=${value(ir[1],offsets)};if(${v}!==null&&${v}!==undefined&&typeof ${v}!=='boolean'&&${v}!==''){if(adjacent)html+='<!-- -->';`);append(`escape(${v})`);statements.push('adjacent=true;}}');
    }else if(ir[0]==='e'){
      append(JSON.stringify('<'+ir[1]));
      for(const[name,ref,css]of ir[2])if(name!=='key'){
        const v=fresh();statements.push(`{const ${v}=${value(css||ref,offsets)};if(${v}!==null&&${v}!==undefined&&typeof ${v}!=='boolean'${name==='style'?`&&${v}!==''`:''}){`);append(`${JSON.stringify(' '+displayAttributeName(name)+'="')}+escape(${v})+'"'`);statements.push('}}');
      }
      append(JSON.stringify('>'));statements.push('adjacent=false;');ir[3].forEach(child=>emit(child,offsets));append(JSON.stringify('</'+ir[1]+'>'));statements.push('adjacent=false;');
    }else if(ir[0]==='f')ir[1].forEach(child=>emit(child,offsets));
    else if(ir[0]==='c'){
      const pointer=fresh(),choice=fresh();statements.push(`{const ${pointer}=${value(ir[1],offsets)},${choice}=reader.at(${pointer});if(${choice}!==0&&${choice}!==1)throw new TypeError('Display branch');if(${choice}){`);emit(ir[3][1],[...offsets,pointer]);statements.push('}else{');emit(ir[3][0],[...offsets,pointer]);statements.push('}}');
    }else{
      const pointer=fresh(),count=fresh(),index=fresh(),offset=fresh(),keys=fresh(),key=fresh();
      statements.push(`{const ${pointer}=${value(ir[1],offsets)},${count}=reader.at(${pointer});if(!Number.isSafeInteger(${count})||${count}<0||${count}>20000||reader.at(${pointer}+1)!==${ir[3]})throw new RangeError('Display list');reader.range(${pointer}+2,${count}*${ir[3]});const ${keys}=new Set();for(let ${index}=0;${index}<${count};${index}++){const ${offset}=${pointer}+2+${index}*${ir[3]};`);
      const nested=[...offsets,offset],raw=fresh();statements.push(`const ${raw}=${ir[5]?value(ir[5],nested):'undefined'},${key}=${raw}===undefined?${index}:'k:'+String(${raw});if(${keys}.has(${key}))throw new TypeError('Duplicate display keys');${keys}.add(${key});`);emit(ir[4],nested);statements.push('}}');
    }
  }
  plan.root[3].forEach(child=>emit(child,['0']));statements.push('return html;');
  const result=`(scope,escape)=>{${statements.join('')}}`;if(result.length>262144)fail();return result;
}

export function compilePresentationDom(template,dataName,literalsName,styles,layout) {
  try {
    function value(node,variables) {
      if(t.isJSXExpressionContainer(node))return value(node.expression,variables);
      if(t.isMemberExpression(node)&&node.computed&&t.isIdentifier(node.object)&&t.isNumericLiteral(node.property)){
        if(node.object.name===literalsName)return['l',node.property.value];
        const depth=variables.indexOf(node.object.name);if(depth>=0)return['v',depth,node.property.value];
      }
      if(['StringLiteral','NumericLiteral','BooleanLiteral','NullLiteral'].includes(node.type))return['s',node.value];
      fail();
    }
    function compile(node,variables,parent='',insideP=false,svg=false,mapRoot=false) {
      if(t.isJSXExpressionContainer(node))return t.isJSXEmptyExpression(node.expression)?['f',[]]:compile(node.expression,variables,parent,insideP,svg);
      if(t.isJSXFragment(node))return['f',t.react.buildChildren(node).map(child=>compile(child,variables,parent,insideP,svg))];
      if(t.isJSXElement(node)){
        const tag=node.openingElement.name.name;svg ||= tag==='svg';
        if(!(svg?presentationSvgTags:htmlTags).has(tag)||insideP&&!svg&&blockTags.has(tag))fail();
        if(parent==='table'&&!['thead','tbody','tfoot'].includes(tag)||['thead','tbody','tfoot'].includes(parent)&&tag!=='tr'||parent==='tr'&&!['td','th'].includes(tag))fail();
        const attrs=node.openingElement.attributes.map(a=>{
          if(!t.isJSXAttribute(a))fail();
          const ref=value(a.value||(/^(data|aria)-/.test(a.name.name)?t.stringLiteral('true'):t.booleanLiteral(true)),variables);
          return[a.name.name,ref,...(a.name.name==='style'?[['l',styles.get(ref[1])]]:[])];
        });
        if(!mapRoot&&attrs.some(a=>a[0]==='key'))fail();
        return['e',tag,attrs,t.react.buildChildren(node).map(child=>compile(child,variables,tag,insideP||tag==='p',svg)),attrs.find(a=>a[0]==='key')?.[1]||null,svg];
      }
      if(t.isCallExpression(node)&&t.isMemberExpression(node.callee)&&node.callee.property.name==='map'){
        const callback=node.arguments[0];if(!t.isArrowFunctionExpression(callback)||!t.isIdentifier(callback.params[0])||!t.isJSXElement(callback.body))fail();
        const depth=variables.length,body=compile(callback.body,[...variables,callback.params[0].name],parent,insideP,svg,true);
        const ref=value(node.callee.object,variables);
        return['r',ref,depth,null,body,body[4]];
      }
      if(t.isCallExpression(node)&&node.prnextBranch&&t.isArrowFunctionExpression(node.callee)){
        const branch=node.callee.body,depth=variables.length,name=node.callee.params[0].name;
        return['c',value(node.arguments[0],variables),depth,[compile(branch.alternate,[...variables,name],parent,insideP,svg),compile(branch.consequent,[...variables,name],parent,insideP,svg)]];
      }
      if(['table','thead','tbody','tfoot','tr'].includes(parent))fail();
      return['t',value(node,variables)];
    }
    const root=compile(template,[dataName]);if(root[0]!=='e')return;
    function widths(ir,scopes) {
      if(ir[0]==='r'){
        const child=scopes[ir[1][1]].arrays[ir[1][2]];if(!child)fail();ir[3]=child.width;
        widths(ir[4],[...scopes,child]);
      }else if(ir[0]==='c'){
        const choices=scopes[ir[1][1]].branches[ir[1][2]];if(!choices)fail();
        ir[3].forEach((child,i)=>widths(child,[...scopes,choices[i]]));
      }else if(ir[0]==='e')ir[3].forEach(child=>widths(child,scopes));
      else if(ir[0]==='f')ir[1].forEach(child=>widths(child,scopes));
    }
    widths(root,[layout]);
    const plan={version:1,root,width:layout.width};
    const writer=compileWriter(plan);
    return{dom:plan,domWriter:writer,domClient:`import{createPresentationDom}from'prnext:presentation-dom';\nexport default createPresentationDom(${JSON.stringify(plan)},${writer});`};
  }catch{return;}
}

export function presentationDomSsrModule(analysis,ordinaryEntry,helper) {
  return `import{createElement}from'react';
import Ordinary from ${JSON.stringify(ordinaryEntry)};
import{renderPresentationDisplay}from ${JSON.stringify(helper)};
const plan=${JSON.stringify(analysis.dom)};
const writer=${analysis.domWriter};
export default function Presentation(props){
if(props.__prnextPresentation===undefined)return props.__prnextOrdinary;
try{const result=renderPresentationDisplay(plan,props.__prnextPresentation,props.__prnextLiterals,writer);return createElement(plan.root[1],{...result.props,dangerouslySetInnerHTML:{__html:result.html}});}
catch{return createElement(Ordinary,props);}
}`;
}
