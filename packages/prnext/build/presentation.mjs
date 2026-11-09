import {parse} from '@babel/parser';
import generateModule from '@babel/generator';
import * as t from '@babel/types';
import {compileAutomaticPresentation} from './presentation-auto.mjs';
import {staticPresentationSvg} from './presentation-svg.mjs';

const generate = generateModule.default || generateModule;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const slot = () => ({kind: 'unknown', fields: Object.create(null)});
const fail = reason => { throw new Error(reason); };
const key = node => {
  const value = node?.type === 'Identifier' ? node.name : node?.type === 'StringLiteral' ? node.value : undefined;
  if (!value || forbidden.has(value)) fail('Only literal, safe property names are supported');
  return value;
};

/** Deliberately small pure JSX language. No code is evaluated during discovery.
 * The generated browser module contains just the checked component expression;
 * imports, comments, other exports and server implementations cannot tag along.
 */
export function analyzePresentation(source, filename = 'presentation.jsx', {automatic = false} = {}) {
  if (!automatic && !source.includes('use presentation')) return null;
  try {
    if (source.length > 262144) fail('Component source exceeds the 256 KiB analysis limit');
    const typed = /\.[cm]?tsx?$/.test(filename);
    const ast = parse(source, {sourceType: 'module', sourceFilename: filename,
      plugins: [...(!typed || /\.tsx$/.test(filename) ? ['jsx'] : []), ...(typed ? ['typescript'] : [])]});
    if (!automatic && !ast.program.directives.some(item => item.value.value === 'use presentation')) return null;
    if (/@jsx(?:ImportSource|Runtime|Frag)?\b/.test(source)) fail('Custom JSX pragmas require ordinary rendering');
    if (ast.program.directives.some(item => ['use client', 'use server', 'use cache'].includes(item.value.value)||item.value.value.startsWith('use cache:'))) fail('Other React boundary directives require ordinary rendering');
    const statements = ast.program.body.filter(node => node.type !== 'EmptyStatement' &&
      !(node.type === 'ImportDeclaration' && node.importKind === 'type') &&
      !['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(node.type));
    if (statements.length !== 1 || statements[0].type !== 'ExportDefaultDeclaration') fail('Only a default component and erased type declarations are supported');
    const component = statements[0].declaration;
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(component.type) || component.async || component.generator || component.params.length > 1) fail('A synchronous default function is required');
    const schema = slot(); schema.kind = 'object';
    const bindings = new Map();
    const replacements = new Map(), positions = new Map(), fusedMaps = new Map(), arrayShapes = [], mapLayouts=[];
    // Fresh names must also avoid JSX/TS identifiers and callback bindings.
    const names = new Set();
    function identifiers(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'Identifier') names.add(node.name);
      for (const property of t.VISITOR_KEYS[node.type] || []) {
        const value = node[property];
        if (Array.isArray(value)) value.forEach(identifiers); else identifiers(value);
      }
    }
    identifiers(component);
    function fresh() { let name = '__prnext_presentation'; while (names.has(name)) name += '_'; names.add(name); return name; }
    const dataName = fresh();
    const field = (parent, name) => {
      if (parent.kind === 'scalar' || parent.kind === 'array' && name !== 'length') fail('A value has incompatible uses');
      if (parent.kind === 'unknown') parent.kind = 'object';
      return parent.fields[name] ||= slot();
    };
    function bind(pattern, value, scope, access) {
      if (pattern.type === 'Identifier') {
        if (scope.has(pattern.name)) fail('Shadowed bindings require ordinary rendering');
        scope.set(pattern.name, {value, access}); return;
      }
      if (pattern.type !== 'ObjectPattern' || value.kind === 'scalar' || value.kind === 'array') fail('Only simple props or row destructuring is supported');
      // Parameter destructuring reads even unused properties. Automatic mode
      // must validate those descriptors too, preserving getters/throws through
      // ordinary rendering rather than silently removing application effects.
      if (automatic) value.kind = 'object';
      for (const item of pattern.properties) {
        if (item.type !== 'ObjectProperty' || item.computed || item.value.type !== 'Identifier') fail('Rest, defaults and nested destructuring require ordinary rendering');
        const name = key(item.key);
        if (automatic) (value.destructured ||= new Set()).add(name);
        bind(item.value, field(value, name), scope, {...access, path: [...access.path, {parent: value, name}]});
      }
    }
    if (component.params.length) bind(component.params[0], schema, bindings, {base: dataName, path: []});
    const unwrap = node => ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TypeCastExpression'].includes(node?.type) ? unwrap(node.expression) : node;
    function reference(raw, scope) {
      const node = unwrap(raw);
      if (node?.type === 'Identifier' && scope.has(node.name)) return scope.get(node.name);
      if (node?.type === 'MemberExpression' && !node.optional && !node.computed) {
        const parent = reference(node.object, scope), name = key(node.property);
        return {value: field(parent.value, name), access: {...parent.access, path: [...parent.access.path, {parent: parent.value, name}]}};
      }
      fail('Only statically named props and row fields may be read');
    }
    function scalar(value) {
      if (value.kind !== 'unknown' && value.kind !== 'scalar') fail('Object identity, object rendering and array coercion require ordinary rendering');
      value.kind = 'scalar';
    }
    function body(fn) {
      if (fn.body.type !== 'BlockStatement') return fn.body;
      if (fn.body.directives?.length || fn.body.body.length !== 1 || fn.body.body[0].type !== 'ReturnStatement' || !fn.body.body[0].argument) fail('The component and map callbacks must contain a single return expression');
      return fn.body.body[0].argument;
    }
    let nodes = 0;
    function booleanTest(raw, scope, depth = 0) {
      if (++nodes > 10000 || depth > 64) fail('Presentation expression exceeds analysis limits');
      const node = unwrap(raw);
      if (node.type === 'BooleanLiteral') return;
      if (node.type === 'UnaryExpression' && node.operator === '!') return booleanTest(node.argument, scope, depth + 1);
      const ref = reference(node, scope);
      scalar(ref.value); ref.value.boolean = true; replacements.set(node, ref.access);
    }
    function visit(raw, scope, depth = 0) {
      if (++nodes > 10000 || depth > 64) fail('Presentation expression exceeds analysis limits');
      const node = unwrap(raw), next = child => visit(child, scope, depth + 1);
      switch (node.type) {
        case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': case 'NullLiteral': case 'JSXText': return;
        case 'Identifier':
          if (node.name === 'undefined' && !scope.has(node.name) && component.id?.name !== 'undefined') return;
          // falls through: only actual expression reads are rewritten, never JSX names.
        case 'MemberExpression': {
          const ref = reference(node, scope); scalar(ref.value); replacements.set(node, ref.access); return;
        }
        case 'UnaryExpression':
          if (!['!', '+', '-', '~', 'typeof'].includes(node.operator)) fail('Side effects are not supported');
          return next(node.argument);
        case 'BinaryExpression':
          if (['in', 'instanceof'].includes(node.operator)) fail('Object inspection is not supported');
          next(node.left); return next(node.right);
        case 'LogicalExpression':
          if (automatic) { next(node.left); return next(node.right); }
          fail('Short-circuit data disclosure requires ordinary server rendering'); break;
        case 'ConditionalExpression': {
          if (automatic) { next(node.test); next(node.consequent); next(node.alternate); return; }
          // Do not transfer values from a branch the server did not display.
          // Pure boolean display choices (e.g. Available/Sold) are supported.
          booleanTest(node.test, scope);
          const reads = replacements.size;
          next(node.consequent); next(node.alternate);
          if (reads !== replacements.size) fail('Conditionally displayed data requires ordinary server rendering');
          return;
        }
        case 'TemplateLiteral': node.expressions.forEach(next); return;
        case 'JSXExpressionContainer': if (node.expression.type !== 'JSXEmptyExpression') next(node.expression); return;
        case 'JSXFragment': node.children.forEach(next); return;
        case 'JSXElement': {
          const opening = node.openingElement;
          if(opening.name.type==='JSXIdentifier'&&opening.name.name==='svg'){
            if(!staticPresentationSvg(node))fail('SVG must be literal, resource-free and statically checked');
            return;
          }
          if (opening.name.type !== 'JSXIdentifier' || !/^[a-z][a-z0-9]*$/.test(opening.name.name) || ['script', 'style', 'form', 'input', 'textarea', 'select', 'option', 'optgroup', 'details', 'summary', 'audio', 'video', 'canvas'].includes(opening.name.name)) fail('Only stateless intrinsic display elements are supported');
          for (const attr of opening.attributes) {
            if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier' || /^(on|ref$|dangerouslySetInnerHTML$)/i.test(attr.name.name)) fail('Spreads, refs, events and raw HTML require ordinary rendering');
            if (attr.value) next(attr.value);
          }
          node.children.forEach(next); return;
        }
        case 'ObjectExpression':
          for (const property of node.properties) {
            if (property.type !== 'ObjectProperty' || property.computed || property.method) fail('Only literal object fields are supported');
            key(property.key); next(property.value);
          }
          return;
        case 'CallExpression': {
          const callee = node.callee;
          if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'map' || node.arguments.length !== 1) fail('Only array.map with an inline pure callback is supported');
          const target = reference(callee.object, scope), array = target.value;
          replacements.set(unwrap(callee.object), target.access);
          if (!['unknown', 'object', 'array'].includes(array.kind) || Object.keys(array.fields).some(name => name !== 'length')) fail('A mapped value has incompatible uses');
          array.kind = 'array'; array.item ||= slot();
          const mapIndex=arrayShapes.length;
          fusedMaps.set(generate(node, {comments: false}).code,mapIndex);arrayShapes.push(array);
          const callback = node.arguments[0];
          if (callback.type !== 'ArrowFunctionExpression' || callback.async || callback.params.length < 1 || callback.params.length > 2) fail('A synchronous inline map callback is required');
          const nested = new Map(scope);
          const parameter = callback.params[0], base = parameter.type === 'Identifier' ? parameter.name : fresh();
          bind(parameter, array.item, nested, {base, path: []});
          if (parameter.type !== 'Identifier') replacements.set(parameter, {base, path: []});
          if (callback.params[1]) {
            if (callback.params[1].type !== 'Identifier') fail('The map index must be an identifier');
            bind(callback.params[1], {kind: 'scalar', fields: {}}, nested, {base: callback.params[1].name, path: []});
          }
          visit(body(callback), nested, depth + 1);
          mapLayouts[mapIndex]={parameter:base,shape:array.item,aliases:[...nested].filter(([,binding])=>binding.access.base===base).map(([name,binding])=>({name,path:binding.access.path.map(item=>item.name)}))};
          return;
        }
        default: fail(`${node.type} requires ordinary server rendering`);
      }
    }
    visit(body(component), bindings);
    function finalize(value, depth = 0) {
      if (depth > 32) fail('Prop schema exceeds the depth limit');
      if (value.kind === 'unknown') return {kind: 'discard'};
      if (value.kind === 'array') return {kind: 'array', item: finalize(value.item, depth + 1)};
      if (value.kind === 'object') {
        const fields = Object.entries(value.fields).filter(([name, child]) => child.kind !== 'unknown' || automatic && value.destructured?.has(name));
        positions.set(value, new Map(fields.map(([name], index) => [name, index])));
        return {kind: 'object', fields: Object.fromEntries(fields.map(([name, child]) => [name, finalize(child, depth + 1)]))};
      }
      return {kind: 'scalar', ...(value.boolean ? {boolean: true} : {})};
    }
    const expression = generate(component, {comments: false}).code;
    const finalized = finalize(schema);
    const fused = automatic ? compileAutomaticPresentation(component, dataName, {
      fusedMaps,fusedLayouts:mapLayouts.map(layout=>({...layout,shape:finalize(layout.shape)})), parameter: component.params[0] || t.identifier(dataName),
    }) : undefined;
    const flat = automatic ? compileAutomaticPresentation(component,dataName,{
      fusedMaps,fusedLayouts:mapLayouts.map(layout=>({...layout,shape:finalize(layout.shape)})),parameter:component.params[0]||t.identifier(dataName),flat:true,
    }) : undefined;
    function packed(access) {
      let node = t.identifier(access.base);
      for (const {parent, name} of access.path) {
        if (parent.kind === 'array' && name === 'length') node = t.memberExpression(node, t.identifier('length'));
        else {
          const index = positions.get(parent)?.get(name);
          if (index === undefined) fail('A referenced field has no packed position');
          node = t.memberExpression(node, t.numericLiteral(index), true);
        }
      }
      return node;
    }
    function rewrite(node) {
      if (!node || typeof node !== 'object') return node;
      if (replacements.has(node)) return packed(replacements.get(node));
      for (const property of t.VISITOR_KEYS[node.type] || []) {
        const value = node[property];
        node[property] = Array.isArray(value) ? value.map(rewrite) : rewrite(value);
      }
      return node;
    }
    rewrite(component);
    component.params = [t.objectPattern([t.objectProperty(t.identifier('__prnextPresentation'), t.identifier(dataName))])];
    if (automatic) return {eligible:true, schema:finalized, expression, ...compileAutomaticPresentation(component, dataName),
      fusedProjector: fused.displayProjector,flatProjector:flat.displayProjector,fusedGuards:true, arraySchemas: arrayShapes.map(shape => finalize(shape.item))};
    return {eligible: true, schema: finalized, expression, client: `export default ${generate(component, {comments: false}).code};`};
  } catch (error) {
    return {eligible: false, reason: error.message};
  }
}

export function presentationServerModule(analysis, id, helper, {island=false} = {}) {
  if (analysis.automatic) return `import {registerClientReference} from 'react-server-dom-webpack/server';
import {createElement} from 'react';
import {createFusedPresentationProjector} from ${JSON.stringify(helper)};
const original=(${analysis.expression});
const reference=registerClientReference(function(){throw new Error('Presentation reference cannot be called on the RSC server')},${JSON.stringify(id)},'default');
const selected=createFusedPresentationProjector(${JSON.stringify(analysis.schema)},${JSON.stringify(analysis.arraySchemas)},${analysis.dom?analysis.flatProjector:analysis.fusedProjector},{minArrayEntries:${analysis.dom?0:analysis.minArrayEntries},literals:${JSON.stringify(analysis.literals)},packet:true,inlineValidation:true,flatModel:${!!analysis.dom}});
${island
  ? `export default function Presentation(read,ordinary){let props;try{props=read()}catch{return createElement(reference,{__prnextOrdinary:ordinary()})}const projected=selected(props);return createElement(reference,projected===null?{__prnextOrdinary:ordinary()}:{__prnextPresentation:projected.data,__prnextLiterals:projected.literals});}`
  : `export default function Presentation(props){const projected=selected(props);return createElement(reference,projected===null?{__prnextOrdinary:original(props)}:{__prnextPresentation:projected.data,__prnextLiterals:projected.literals});}`}`;
  return `import {registerClientReference} from 'react-server-dom-webpack/server';
import {createElement} from 'react';
import {createPresentationProjector} from ${JSON.stringify(helper)};
const original=(${analysis.expression});
const reference=registerClientReference(function(){throw new Error('Presentation reference cannot be called on the RSC server')},${JSON.stringify(id)},'default');
const schema=${JSON.stringify(analysis.schema)};
const project=createPresentationProjector(schema);
export default function Presentation(props){const projected=project(props);return projected===null?original(props):createElement(reference,{__prnextPresentation:projected});}`;
}
