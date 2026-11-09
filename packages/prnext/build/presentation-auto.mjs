import generateModule from '@babel/generator';
import * as t from '@babel/types';
import {compilePresentationHtml} from './presentation-html.mjs';
import {presentationCost} from './presentation-cost.mjs';

const generate = generateModule.default || generateModule;
const fail = reason => { throw new Error(reason); };
const textAttributes = new Set(['id', 'title', 'className', 'role', 'lang', 'dir', 'tabIndex', 'htmlFor']);
const literal = node => ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral'].includes(node?.type);

/** Partition checked JSX into a public template and SERVER-evaluated display
 * slots. Never send an arithmetic operand, branch condition, private key name,
 * or hidden boolean just because a pure component happened to read it.
 */
export function compileAutomaticPresentation(component, inputName, {fusedMaps,fusedLayouts,parameter} = {}) {
  let sequence = 0, maps = 0, elements = 0, repeatedElements=0, repeatedAttributeBytes=0;
  const names = new Set();
  function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (t.isIdentifier(node)) names.add(node.name);
    for (const key of t.VISITOR_KEYS[node.type] || []) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach(collect); else collect(value);
    }
  }
  collect(component);
  const fresh = () => { let name; do { name = `__prnext_display_${sequence++}`; } while (names.has(name)); names.add(name); return name; };
  const output = fresh(), normalizer = fresh(), props = fresh(), map = fresh(), literalsName=fresh(), mark=fresh(),guard=fresh();
  const literals=[],literalScopes=new Map();
  function literalSlot(value,values){
    const index=literals.length;literals.push(value);
    let scope=literalScopes.get(values);if(!scope)literalScopes.set(values,scope=[]);scope.push(index);
    return access(literalsName,index);
  }
  const markers=values=>(literalScopes.get(values)||[]).map(index=>t.expressionStatement(t.callExpression(t.identifier(mark),[t.numericLiteral(index)])));
  const access = (base, index) => t.memberExpression(t.identifier(base), t.numericLiteral(index), true);
  const expression = fn => fn.body.type === 'BlockStatement' ? fn.body.body[0].argument : fn.body;
  const hasJsx = node => {
    if (!node || typeof node !== 'object') return false;
    if (t.isJSXElement(node) || t.isJSXFragment(node)) return true;
    return (t.VISITOR_KEYS[node.type] || []).some(key => Array.isArray(node[key]) ? node[key].some(hasJsx) : hasJsx(node[key]));
  };
  const hasArrayOperation=node=>node&&typeof node==='object'&&(
    t.isCallExpression(node)&&t.isMemberExpression(node.callee)&&node.callee.property.name==='map'||
    (t.VISITOR_KEYS[node.type]||[]).some(key=>Array.isArray(node[key])?node[key].some(hasArrayOperation):hasArrayOperation(node[key])));
  function substitute(node,locals){
    if(!locals?.size)return t.cloneNode(node,true);
    const found=locals.get(generate(node,{comments:false}).code);if(found)return t.cloneNode(found,true);
    const clone=t.cloneNode(node,true);
    for(const key of t.VISITOR_KEYS[node.type]||[]){
      if((t.isMemberExpression(node)||t.isObjectProperty(node))&&!node.computed&&key===(t.isMemberExpression(node)?'property':'key'))continue;
      if(Array.isArray(node[key]))clone[key]=node[key].map(child=>child?substitute(child,locals):child);
      else if(node[key])clone[key]=substitute(node[key],locals);
    }
    return clone;
  }
  function guarded(layout,inherited){
    const statements=[],paths=[],locals=new Map(inherited);
    const count=shape=>shape.kind==='discard'?0:shape.kind==='object'?1+Object.values(shape.fields).reduce((n,child)=>n+count(child),0):1;
    const visits=count(layout.shape);
    if(visits)statements.push(t.expressionStatement(t.callExpression(t.memberExpression(t.identifier(guard),t.identifier('reserve')),[t.numericLiteral(visits)])));
    const reject=()=>t.throwStatement(t.memberExpression(t.identifier(guard),t.identifier('rejected')));
    function read(shape,object,key,path){
      const value=t.identifier(fresh());
      if(key===undefined)statements.push(t.variableDeclaration('const',[t.variableDeclarator(value,object)]));
      else{
        const descriptor=t.identifier(fresh());
        statements.push(t.variableDeclaration('const',[t.variableDeclarator(descriptor,t.callExpression(t.memberExpression(t.identifier(guard),t.identifier('own')),[object,t.stringLiteral(key)]))]));
        const missing=t.binaryExpression('===',t.cloneNode(descriptor),t.unaryExpression('void',t.numericLiteral(0)));
        statements.push(t.ifStatement(t.conditionalExpression(missing,t.binaryExpression('in',t.stringLiteral(key),t.memberExpression(t.identifier(guard),t.identifier('prototype'))),t.unaryExpression('!',t.binaryExpression('in',t.stringLiteral('value'),t.cloneNode(descriptor)))),reject()));
        statements.push(t.variableDeclaration('const',[t.variableDeclarator(value,t.conditionalExpression(t.cloneNode(missing),t.unaryExpression('void',t.numericLiteral(0)),t.memberExpression(t.cloneNode(descriptor),t.identifier('value'))))]));
      }
      if(shape.kind==='object'||shape.kind==='array')statements.push(t.expressionStatement(t.callExpression(t.memberExpression(t.identifier(guard),t.identifier(shape.kind)),[t.cloneNode(value)])));
      else if(shape.kind==='scalar'){
        const v=()=>t.cloneNode(value),type=kind=>t.binaryExpression('===',t.unaryExpression('typeof',v()),t.stringLiteral(kind));
        const allowed=t.logicalExpression('||',t.logicalExpression('||',t.binaryExpression('===',v(),t.nullLiteral()),t.binaryExpression('===',v(),t.unaryExpression('void',t.numericLiteral(0)))),t.logicalExpression('||',t.logicalExpression('||',type('string'),type('boolean')),t.logicalExpression('&&',type('number'),t.callExpression(t.memberExpression(t.identifier(guard),t.identifier('finite')),[v()]))));
        statements.push(t.ifStatement(t.unaryExpression('!',shape.boolean?type('boolean'):allowed),reject()));
      }
      paths.push({path,value});
      if(shape.kind==='object')for(const[name,child]of Object.entries(shape.fields))read(child,t.cloneNode(value),name,[...path,name]);
    }
    read(layout.shape,t.identifier(layout.parameter),undefined,[]);
    for(const alias of layout.aliases)for(const item of paths){
      if(alias.path.length>item.path.length||!alias.path.every((name,i)=>name===item.path[i]))continue;
      let expression=t.identifier(alias.name);
      for(const name of item.path.slice(alias.path.length))expression=t.memberExpression(expression,t.identifier(name));
      locals.set(generate(expression,{comments:false}).code,item.value);
    }
    return{statements,locals};
  }
  function pack(node, base, values, repeated=false,locals) {
    function slot(value, kind) {
      if (hasJsx(value)) fail('Conditional JSX retains ordinary rendering');
      if (hasArrayOperation(value)) fail('Array operations inside scalar expressions retain ordinary rendering');
      const index = values.length;
      values.push(t.callExpression(t.identifier(normalizer), [substitute(value,locals), t.stringLiteral(kind)]));
      return access(base, index);
    }
    if (t.isJSXElement(node)) {
      if (['html','head','body','title','meta','link','base','iframe','object','embed','template','noscript'].includes(node.openingElement.name.name)) fail('Document and resource elements retain ordinary rendering');
      elements++;
      if(repeated)repeatedElements++;
      const result = t.cloneNode(node, true);
      for (const attribute of result.openingElement.attributes) {
        const name = attribute.name.name;
        if(repeated)repeatedAttributeBytes+=Buffer.byteLength(name)+3;
        if (name === 'style') {
          const style = attribute.value?.expression;
          if (!t.isObjectExpression(style) || !style.properties.every(property => t.isObjectProperty(property) && literal(property.value))) fail('Dynamic styles retain ordinary rendering');
          const value=Object.fromEntries(style.properties.map(property=>[property.key.name??property.key.value,t.isNullLiteral(property.value)?null:property.value.value]));
          attribute.value.expression=literalSlot(value,values);
          continue;
        }
        const kind = name === 'key' ? 'key' : /^(data|aria)-[a-zA-Z0-9_.-]+$/.test(name) ? 'attribute' : textAttributes.has(name) ? 'textAttribute' : undefined;
        // URL sanitization, resource hints, boolean attributes, special React
        // properties and custom elements retain React's original server path.
        if (!kind) fail('Unverified HTML attributes retain ordinary rendering');
        if (t.isJSXExpressionContainer(attribute.value)) attribute.value.expression = slot(attribute.value.expression, kind);
        else if(t.isStringLiteral(attribute.value))attribute.value=t.jsxExpressionContainer(literalSlot(attribute.value.value,values));
      }
      result.children = result.children.map(child => pack(child, base, values,repeated,locals));
      return result;
    }
    if (t.isJSXFragment(node)) {
      const result = t.cloneNode(node, true);
      result.children = node.children.map(child => pack(child, base, values,repeated,locals));
      return result;
    }
    if (t.isJSXText(node)) {
      const children=t.react.buildChildren(t.jsxFragment(t.jsxOpeningFragment(),t.jsxClosingFragment(),[t.cloneNode(node)]));
      return children.length?t.jsxExpressionContainer(literalSlot(children[0].value,values)):t.jsxText('');
    }
    if (t.isJSXExpressionContainer(node)) {
      if (t.isJSXEmptyExpression(node.expression)) return t.jsxExpressionContainer(t.jsxEmptyExpression());
      return t.jsxExpressionContainer(pack(node.expression, base, values,repeated,locals));
    }
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && node.callee.property.name === 'map') {
      maps++;
      const index = values.length, rows = fresh(), rowValues = [];
      const callback = node.arguments[0];
      const mapIndex=fusedMaps?.get(generate(node,{comments:false}).code),layout=fusedLayouts?.[mapIndex];
      const checked=layout?guarded(layout,locals):undefined;
      const rendered = pack(expression(callback), rows, rowValues,true,checked?.locals||locals);
      const parameters=layout?[t.identifier(layout.parameter),...(callback.params[1]?[t.cloneNode(callback.params[1],true)]:[])]:callback.params.map(param => t.cloneNode(param,true));
      if(parameters.length<2)parameters.push(t.identifier(fresh()));
      const marks=markers(rowValues);
      const serverCallback = t.arrowFunctionExpression(parameters,marks.length||checked?t.blockStatement([
        ...(checked?.statements||[]),
        ...(marks.length?[t.ifStatement(t.binaryExpression('===',t.cloneNode(parameters[1]),t.numericLiteral(0)),t.blockStatement(marks))]:[]),
        t.returnStatement(t.arrayExpression(rowValues)),
      ]):t.arrayExpression(rowValues));
      values.push(fusedMaps
        ? t.callExpression(t.identifier(map), [t.numericLiteral(mapIndex), substitute(node.callee.object,locals), serverCallback])
        : t.callExpression(t.memberExpression(t.cloneNode(node.callee.object, true), t.identifier('map')), [serverCallback]));
      return t.callExpression(t.memberExpression(access(base, index), t.identifier('map')), [t.arrowFunctionExpression([t.identifier(rows)], rendered)]);
    }
    return slot(node, 'text');
  }
  const values = [];
  const template = pack(expression(component), output, values);
  if (!maps && elements < 64) fail('Small non-repeated components retain ordinary rendering');
  const data = t.memberExpression(t.identifier(props), t.identifier('__prnextPresentation'));
  const client = t.functionDeclaration(t.identifier('Presentation'), [t.identifier(props)], t.blockStatement([
    t.ifStatement(t.binaryExpression('===',t.cloneNode(data),t.unaryExpression('void',t.numericLiteral(0))),t.returnStatement(t.memberExpression(t.identifier(props),t.identifier('__prnextOrdinary')))),
    t.variableDeclaration('const',[t.variableDeclarator(t.identifier(output),data)]),
    t.variableDeclaration('const',[t.variableDeclarator(t.identifier(literalsName),t.memberExpression(t.identifier(props),t.identifier('__prnextLiterals')))]),
    t.returnStatement(template),
  ]));
  const project = t.arrowFunctionExpression([
    parameter ? t.cloneNode(parameter, true) : t.identifier(inputName),
    t.identifier(normalizer), ...(fusedMaps ? [t.identifier(map)] : []),
    t.assignmentPattern(t.identifier(mark),t.arrowFunctionExpression([],t.blockStatement([]))),
    ...(fusedMaps?[t.identifier(guard)]:[]),
  ],t.blockStatement([...markers(values),t.returnStatement(t.arrayExpression(values))]));
  const clientSource=generate(t.exportDefaultDeclaration(client), {comments: false}).code;
  const cost=!fusedMaps?presentationCost({elements,maps,slots:values.length,repeatedElements,repeatedAttributeBytes,client:clientSource}):undefined;
  if(cost?.decision==='ordinary')fail(cost.reason);
  return {
    automatic: true,
    minArrayEntries: cost?.minArrayEntries??(maps?32:0),
    displayProjector: generate(project, {comments: false}).code,
    client: clientSource,
    literals,
    ...(!fusedMaps ? {html:compilePresentationHtml(template,output,fresh,{literalsName}),cost} : {}),
  };
}
