import {createRequire} from 'node:module';
import generateModule from '@babel/generator';
import * as t from '@babel/types';

const generate = generateModule.default || generateModule;
const require = createRequire(import.meta.url);
// The build entry establishes NODE_ENV after its static imports. Loading React
// here would pin a development singleton before a production/PPR build starts.
// Resolve both peers together only when literal serialization is actually used.
let renderer;
function literalRenderer() {
  return renderer ||= {...require('react'), renderToString:require('react-dom/server').renderToString};
}
// No resource hints, form state, namespaces, browser controls or raw-text tags.
const tags = new Set('div span p section article main aside header footer nav ul ol li table thead tbody tfoot tr td th h1 h2 h3 h4 h5 h6 b strong i em small pre code blockquote dl dt dd s u mark sup sub'.split(' '));
const attributes = new Set(['id','title','className','role','lang','dir','tabIndex','htmlFor','key','style']);
const allowedAttribute = name => attributes.has(name) || /^(?:data|aria)-[a-zA-Z0-9_.-]+$/.test(name);
const code = node => generate(node, {comments: false}).code;
const fail = () => {throw new Error('HTML specialization requires a verified intrinsic subtree');};

function constant(node) {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)) return node.value;
  if (t.isObjectExpression(node)) {
    const result = {};
    for (const item of node.properties) {
      if (!t.isObjectProperty(item) || item.computed || item.method) fail();
      const name = item.key.name ?? item.key.value;
      if (['__proto__','constructor','prototype'].includes(name)) fail();
      result[name] = constant(item.value);
    }
    return result;
  }
  fail();
}

function staticElement(node) {
  const {createElement,Fragment}=literalRenderer();
  if (t.isJSXExpressionContainer(node)) return t.isJSXEmptyExpression(node.expression) ? null : constant(node.expression);
  if (t.isStringLiteral(node)) return node.value;
  if (t.isJSXFragment(node)) return createElement(Fragment, null, ...t.react.buildChildren(node).map(staticElement));
  if (!t.isJSXElement(node) || !tags.has(node.openingElement.name.name)) fail();
  const props = {};
  for (const attribute of node.openingElement.attributes) {
    if (!t.isJSXAttribute(attribute) || !allowedAttribute(attribute.name.name)) fail();
    props[attribute.name.name] = attribute.value === null ? true : constant(t.isJSXExpressionContainer(attribute.value) ? attribute.value.expression : attribute.value);
  }
  return createElement(node.openingElement.name.name, props, ...t.react.buildChildren(node).map(staticElement));
}

/** Build-time execution is limited to literals we created, never user modules. */
export function staticPresentationHtml(node) {
  try {const element=staticElement(node);return literalRenderer().renderToString(element);} catch {return undefined;}
}

/** A specialized SSR entry uses an ordinary React intrinsic root. Its HTML is
 * generated from the same checked template as the normal browser JSX entry.
 * React still owns the boundary, streaming, actions, resource policy and root.
 */
export function compilePresentationHtml(template, dataName, fresh, {literalsName}={}) {
  try {
    if (!t.isJSXElement(template) || !tags.has(template.openingElement.name.name)) return;
    const out = fresh(), text = fresh(), escape = fresh(), attribute = fresh(), style = fresh(), styles=new Map();
    const statements = [`let ${out}="",${text}=false;`];
    const bounded=`if(${out}.length>4194304)throw new RangeError("Presentation HTML budget");`;
    let staticBytes = 0;
    const append = value => {if (value) statements.push(`${out}+=${JSON.stringify(value)};${bounded}`);};
    function attrs(node) {
      for (const item of node.openingElement.attributes) {
        if (!t.isJSXAttribute(item) || !allowedAttribute(item.name.name)) fail();
        const name = item.name.name;
        if (name === 'key') continue;
        if(name==='style'&&t.isJSXExpressionContainer(item.value)&&t.isMemberExpression(item.value.expression)&&t.isIdentifier(item.value.expression.object,{name:literalsName})&&t.isNumericLiteral(item.value.expression.property)){
          const index=item.value.expression.property.value;
          if(!styles.has(index))styles.set(index,fresh());
          statements.push(`${out}+=${styles.get(index)};${bounded}`);
        }else if (t.isJSXExpressionContainer(item.value) && name !== 'style') {
          statements.push(`${out}+=${attribute}(${JSON.stringify(name)},${code(item.value.expression)});${bounded}`);
        } else {
          const value = item.value === null ? true : constant(t.isJSXExpressionContainer(item.value) ? item.value.expression : item.value);
          const {createElement,renderToString}=literalRenderer();
          const markup = renderToString(createElement('div', {[name]:value}));
          append(markup.slice(4, -7));
        }
      }
    }
    function emit(node) {
      if (t.isJSXExpressionContainer(node)) {if (!t.isJSXEmptyExpression(node.expression)) emit(node.expression);return;}
      if (t.isJSXElement(node)) {
        if (!tags.has(node.openingElement.name.name)) fail();
        const literal = staticPresentationHtml(node);
        if (literal !== undefined) {append(literal);staticBytes += Buffer.byteLength(literal);statements.push(`${text}=false;`);return;}
        append('<'+node.openingElement.name.name);attrs(node);append('>');statements.push(`${text}=false;`);
        t.react.buildChildren(node).forEach(emit);
        append('</'+node.openingElement.name.name+'>');statements.push(`${text}=false;`);return;
      }
      if (t.isJSXFragment(node)) {t.react.buildChildren(node).forEach(emit);return;}
      if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && node.callee.property.name === 'map') {
        const callback=node.arguments[0];
        if (!t.isArrowFunctionExpression(callback) || callback.params.length !== 1 || !t.isIdentifier(callback.params[0])) fail();
        statements.push(`for(const ${code(callback.params[0])} of ${code(node.callee.object)}){`);emit(callback.body);statements.push('}');return;
      }
      if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isNullLiteral(node) || t.isBooleanLiteral(node) || t.isMemberExpression(node)) {
        const value=fresh();statements.push(`{const ${value}=${code(node)};if(${value}!==null&&${value}!==undefined&&typeof ${value}!=="boolean"&&${value}!==""){if(${text})${out}+="<!-- -->";${out}+=${escape}(${value});${bounded}${text}=true;}}`);return;
      }
      fail();
    }
    t.react.buildChildren(template).forEach(emit);
    statements.push(`return ${out};`);
    const props = template.openingElement.attributes.filter(item => item.name.name !== 'key').map(item => t.objectProperty(t.stringLiteral(item.name.name),item.value===null?t.booleanLiteral(true):t.cloneNode(t.isJSXExpressionContainer(item.value)?item.value.expression:item.value,true)));
    if (props.some(item => !allowedAttribute(item.key.value))) fail();
    return {tag:template.openingElement.name.name,rootProps:code(t.objectExpression(props)),
      writer:`(${dataName},${literalsName},${escape},${attribute},${style})=>{${[...styles].map(([index,name])=>`const ${name}=${style}(${literalsName}[${index}]);`).join('')}${statements.join('')}}`,staticBytes,dataName,literalsName};
  } catch {return undefined;}
}

export function presentationSsrModule(analysis, ordinaryEntry, helper) {
  const html=analysis.html;
  if (!html) return;
  return `import{createElement}from'react';
import Ordinary from ${JSON.stringify(ordinaryEntry)};
import{escapePresentationHtml,presentationHtmlAttribute,presentationHtmlStyle}from ${JSON.stringify(helper)};
const render=${html.writer};
export default function Presentation(props){
if(props.__prnextPresentation===undefined)return props.__prnextOrdinary;
const ${html.dataName}=props.__prnextPresentation;
const ${html.literalsName}=props.__prnextLiterals;
try{return createElement(${JSON.stringify(html.tag)},{...${html.rootProps},dangerouslySetInnerHTML:{__html:render(${html.dataName},${html.literalsName},escapePresentationHtml,presentationHtmlAttribute,presentationHtmlStyle)}});}
catch{return createElement(Ordinary,props);}
}`;
}
