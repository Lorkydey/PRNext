import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import * as t from '@babel/types';
import {createHash} from 'node:crypto';
import {analyzePresentation} from './presentation.mjs';
import {staticPresentationHtml} from './presentation-html.mjs';

const traverse=traverseModule.default||traverseModule,generate=generateModule.default||generateModule;
const boundaries=new Set(['use client','use server','use cache']);
const boundary=value=>boundaries.has(value)||value.startsWith('use cache:');

function component(fn){
  if(fn.node.generator)return false;
  if(fn.parentPath?.isExportDefaultDeclaration())return true;
  const name=fn.node.id?.name||(fn.parentPath?.isVariableDeclarator()?fn.parentPath.node.id?.name:undefined);
  return typeof name==='string'&&/^[A-Z]/.test(name);
}
function rendererOwned(path){
  let child=path;
  for(let parent=path.parentPath;parent;child=parent,parent=parent.parentPath){
    if(parent.isJSXElement()){
      if(child.listKey!=='children'||!t.isJSXIdentifier(parent.node.openingElement.name)||!/^[a-z][a-z0-9]*$/.test(parent.node.openingElement.name.name))return false;
    }else if(parent.isJSXFragment()){
      if(child.listKey!=='children')return false;
    }else if(parent.isJSXExpressionContainer()){
      if(parent.parentPath.isJSXAttribute())return false;
    }else if(parent.isConditionalExpression()){
      if(child.key==='test')return false;
    }else if(parent.isLogicalExpression()){
      if(child.key!=='right')return false;
    }else if(parent.isReturnStatement()){
      return component(parent.getFunctionParent());
    }else if(parent.isArrowFunctionExpression()&&child.key==='body'){
      return component(parent);
    }else return false;
  }
  return false;
}

/** Extract only checked host subtrees, preserving the surrounding server module.
 * Internal render calls execute synchronously at the original JSX position.
 * A separate ordinary closure preserves lexical reads and evaluation order on
 * rejection; neither that closure nor captured server values enter the client.
 */
export function extractPresentationBlocks(source,filename,{identity=filename}={}){
  if(source.length>262144||!source.includes('<')||/@jsx(?:ImportSource|Runtime|Frag)?\b/.test(source))return;
  const typed=/\.[cm]?tsx?$/.test(filename);
  let ast;
  try{ast=parse(source,{sourceType:'module',sourceFilename:filename,plugins:[...(!/\.[cm]?ts$/.test(filename)?['jsx']:[]),...(/\.[cm]?tsx?$/.test(filename)?['typescript']:[])]});}catch{return;}
  if(ast.program.directives.some(d=>boundary(d.value.value)))return;
  const blocks=[],statics=[],imports=[],meta=new WeakMap();let attempts=0;
  function summary(node,depth=0){
    if(!node||typeof node!=='object')return{elements:0,maps:0,custom:false};
    if(depth>64)throw new RangeError('Presentation discovery depth limit');
    if(meta.has(node))return meta.get(node);
    const value={elements:t.isJSXElement(node)?1:0,maps:t.isCallExpression(node)&&t.isMemberExpression(node.callee)&&node.callee.property.name==='map'?1:0,custom:t.isJSXElement(node)&&(!t.isJSXIdentifier(node.openingElement.name)||!/^[a-z][a-z0-9]*$/.test(node.openingElement.name.name))};
    for(const key of t.VISITOR_KEYS[node.type]||[])for(const child of Array.isArray(node[key])?node[key]:[node[key]]){const x=summary(child,depth+1);value.elements+=x.elements;value.maps+=x.maps;value.custom||=x.custom;}
    meta.set(node,value);return value;
  }
  try{summary(ast.program);
  traverse(ast,{
    Function(p){if(p.node.body?.directives?.some(d=>boundary(d.value.value)))p.skip();},
    JSXElement(p){
      if(!p.getFunctionParent()||!rendererOwned(p)||attempts>=128)return;
      const shape=summary(p.node);if(shape.custom||!shape.maps&&shape.elements<64)return;
      attempts++;
      const literal=shape.maps?undefined:staticPresentationHtml(p.node);
      if(literal!==undefined&&Buffer.byteLength(literal)>=1024){
        const element=t.cloneNode(p.node,true),tag=element.openingElement.name.name;
        const html=literal.slice(literal.indexOf('>')+1,-('</'+tag+'>').length);
        element.openingElement.attributes.push(t.jsxAttribute(t.jsxIdentifier('dangerouslySetInnerHTML'),t.jsxExpressionContainer(t.objectExpression([t.objectProperty(t.identifier('__html'),t.stringLiteral(html))]))));
        element.children=[];element.openingElement.selfClosing=false;
        const offset=p.node.start;p.replaceWith(element);p.skip();statics.push({elements:shape.elements,htmlBytes:Buffer.byteLength(html),offset});return;
      }
      // A direct call must not discard the key of an element returned by a map.
      // Its unkeyed descendants can still be discovered below this host root.
      if(p.node.openingElement.attributes.some(a=>t.isJSXAttribute(a)&&a.name.name==='key'))return;
      const captured=new Set();let unresolved=false;
      p.traverse({ReferencedIdentifier(ref){
        if(typed&&ref.findParent(parent=>parent.isTSType?.()))return;
        const name=ref.node.name,binding=ref.scope.getBinding(name);
        if(!binding){if(name!=='undefined')unresolved=true;return;}
        if(binding.path===p||binding.path.findParent(parent=>parent===p))return;
        captured.add(name);
      }});
      if(unresolved||captured.size>64)return;
      const names=[...captured].sort(),pattern=t.objectPattern(names.map(name=>t.objectProperty(t.identifier(name),t.identifier(name),false,true)));
      const component=t.exportDefaultDeclaration(t.functionDeclaration(t.identifier('Block'),[pattern],t.blockStatement([t.returnStatement(t.cloneNode(p.node,true))])));
      const isolated=generate(component,{comments:false}).code,analysis=analyzePresentation(isolated,filename,{automatic:true});
      if(!analysis?.eligible)return;
      const ordinary=t.arrowFunctionExpression([],t.cloneNode(p.node,true));
      const capture=t.arrowFunctionExpression([],t.objectExpression(names.map(name=>t.objectProperty(t.identifier(name),t.identifier(name),false,true))));
      const local=p.scope.getProgramParent().generateUidIdentifier('prnextPresentation');
      const id=createHash('sha256').update(identity+'\0'+String(p.node.start)+'\0'+isolated).digest('hex').slice(0,24),specifier='prnext-presentation:'+id;
      imports.push(t.importDeclaration([t.importDefaultSpecifier(local)],t.stringLiteral(specifier)));
      const call=t.callExpression(t.cloneNode(local),[capture,ordinary]);
      const replacement=p.listKey==='children'&&(p.parentPath.isJSXElement()||p.parentPath.isJSXFragment())?t.jsxExpressionContainer(call):call;
      blocks.push({id,specifier,analysis,offset:p.node.start,captured:names});p.replaceWith(replacement);p.skip();
    },
  });}catch{return;}
  if(!blocks.length&&!statics.length)return;
  ast.program.body.unshift(...imports);
  return{source:generate(ast,{comments:true}).code,blocks,statics,attempts};
}
