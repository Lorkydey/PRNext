import * as t from '@babel/types';
import generateModule from '@babel/generator';
import {staticPresentationHtml} from './presentation-html.mjs';
const generate=generateModule.default||generateModule;
const code=node=>generate(node,{comments:false}).code;
const value=node=>t.isJSXExpressionContainer(node)?node.expression:node;

/** Merge the same JSX shape into server-evaluated scalar choices. A private
 * condition must not cross Flight merely because two equal display trees used
 * different source branches. Static styles must be identical for this merge.
 */
export function mergeDisplayCondition(test,yes,no) {
  function merge(a,b){
    a=value(a);b=value(b);
    if(code(a)===code(b))return t.cloneNode(a,true);
    if(t.isJSXElement(a)&&t.isJSXElement(b)){
      if(a.openingElement.name.name==='svg'||b.openingElement.name.name==='svg')return;
      if(code(a.openingElement.name)!==code(b.openingElement.name)||a.openingElement.attributes.length!==b.openingElement.attributes.length)return;
      const result=t.cloneNode(a,true);
      for(let i=0;i<a.openingElement.attributes.length;i++){
        const x=a.openingElement.attributes[i],y=b.openingElement.attributes[i];
        if(!t.isJSXAttribute(x)||!t.isJSXAttribute(y)||x.name.name!==y.name.name)return;
        if(x.name.name==='style'){if(code(x)!==code(y))return;continue;}
        const merged=merge(x.value===null?t.booleanLiteral(true):x.value,y.value===null?t.booleanLiteral(true):y.value);if(!merged)return;
        result.openingElement.attributes[i].value=t.jsxExpressionContainer(merged);
      }
      const aChildren=t.react.buildChildren(a),bChildren=t.react.buildChildren(b);if(aChildren.length!==bChildren.length)return;
      result.children=[];
      for(let i=0;i<aChildren.length;i++){
        const child=merge(aChildren[i],bChildren[i]);if(!child)return;
        result.children.push(t.isJSXElement(child)||t.isJSXFragment(child)?child:t.jsxExpressionContainer(child));
      }
      return result;
    }
    if(t.isJSXFragment(a)&&t.isJSXFragment(b)){
      const x=t.react.buildChildren(a),y=t.react.buildChildren(b);if(x.length!==y.length)return;
      const children=[];
      for(let i=0;i<x.length;i++){const child=merge(x[i],y[i]);if(!child)return;children.push(t.isJSXElement(child)||t.isJSXFragment(child)?child:t.jsxExpressionContainer(child));}
      return t.jsxFragment(t.jsxOpeningFragment(),t.jsxClosingFragment(),children);
    }
    function jsx(node){return t.isJSXElement(node)||t.isJSXFragment(node)||(t.VISITOR_KEYS[node.type]||[]).some(key=>Array.isArray(node[key])?node[key].some(jsx):node[key]&&jsx(node[key]));}
    if(jsx(a)||jsx(b))return;
    return t.conditionalExpression(t.cloneNode(test,true),t.cloneNode(a,true),t.cloneNode(b,true));
  }
  return merge(yes,no);
}

/** A selector is allowed only when the rendered host geometry is distinct, or
 * two wholly literal React renderings differ. Unknown nested maps/conditions do
 * not establish distinguishability and conservatively retain ordinary output.
 */
export function distinguishableDisplayBranches(yes,no) {
  function geometry(node){
    node=value(node);
    if(t.isJSXElement(node))return[[node.openingElement.name.name,node.children.flatMap(geometry)]];
    if(t.isJSXFragment(node))return node.children.flatMap(geometry);
    if(t.isConditionalExpression(node)||t.isLogicalExpression(node)||t.isCallExpression(node))throw new Error('Unknown display geometry');
    return [];
  }
  try{if(JSON.stringify(geometry(yes))!==JSON.stringify(geometry(no)))return true;}catch{}
  const a=staticPresentationHtml(yes),b=staticPresentationHtml(no);
  const normalize=text=>text?.replace(/\r\n?/g,'\n').replace(/\u0000/g,'\ufffd');
  return a!==undefined&&b!==undefined&&normalize(a)!==normalize(b);
}
