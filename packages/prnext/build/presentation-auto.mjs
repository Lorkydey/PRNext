import generateModule from '@babel/generator';
import * as t from '@babel/types';

const generate = generateModule.default || generateModule;
const fail = reason => { throw new Error(reason); };
const textAttributes = new Set(['id', 'title', 'className', 'role', 'lang', 'dir', 'tabIndex', 'htmlFor']);
const literal = node => ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral'].includes(node?.type);

/** Partition checked JSX into a public template and SERVER-evaluated display
 * slots. Never send an arithmetic operand, branch condition, private key name,
 * or hidden boolean just because a pure component happened to read it.
 */
export function compileAutomaticPresentation(component, inputName) {
  let sequence = 0, maps = 0, elements = 0;
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
  const output = fresh(), normalizer = fresh(), props = fresh();
  const access = (base, index) => t.memberExpression(t.identifier(base), t.numericLiteral(index), true);
  const expression = fn => fn.body.type === 'BlockStatement' ? fn.body.body[0].argument : fn.body;
  const hasJsx = node => {
    if (!node || typeof node !== 'object') return false;
    if (t.isJSXElement(node) || t.isJSXFragment(node)) return true;
    return (t.VISITOR_KEYS[node.type] || []).some(key => Array.isArray(node[key]) ? node[key].some(hasJsx) : hasJsx(node[key]));
  };
  function pack(node, base, values) {
    function slot(value, kind) {
      if (hasJsx(value)) fail('Conditional JSX retains ordinary rendering');
      const index = values.length;
      values.push(t.callExpression(t.identifier(normalizer), [t.cloneNode(value, true), t.stringLiteral(kind)]));
      return access(base, index);
    }
    if (t.isJSXElement(node)) {
      if (['html','head','body','title','meta','link','base','iframe','object','embed','template','noscript'].includes(node.openingElement.name.name)) fail('Document and resource elements retain ordinary rendering');
      elements++;
      const result = t.cloneNode(node, true);
      for (const attribute of result.openingElement.attributes) {
        const name = attribute.name.name;
        if (name === 'style') {
          const style = attribute.value?.expression;
          if (!t.isObjectExpression(style) || !style.properties.every(property => t.isObjectProperty(property) && literal(property.value))) fail('Dynamic styles retain ordinary rendering');
          continue;
        }
        const kind = name === 'key' ? 'key' : /^(data|aria)-[a-zA-Z0-9_.-]+$/.test(name) ? 'attribute' : textAttributes.has(name) ? 'textAttribute' : undefined;
        // URL sanitization, resource hints, boolean attributes, special React
        // properties and custom elements retain React's original server path.
        if (!kind) fail('Unverified HTML attributes retain ordinary rendering');
        if (t.isJSXExpressionContainer(attribute.value)) attribute.value.expression = slot(attribute.value.expression, kind);
      }
      result.children = result.children.map(child => pack(child, base, values));
      return result;
    }
    if (t.isJSXFragment(node)) {
      const result = t.cloneNode(node, true);
      result.children = node.children.map(child => pack(child, base, values));
      return result;
    }
    if (t.isJSXText(node)) return t.cloneNode(node);
    if (t.isJSXExpressionContainer(node)) {
      if (t.isJSXEmptyExpression(node.expression)) return t.jsxExpressionContainer(t.jsxEmptyExpression());
      return t.jsxExpressionContainer(pack(node.expression, base, values));
    }
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && node.callee.property.name === 'map') {
      maps++;
      const index = values.length, rows = fresh(), rowValues = [];
      const callback = node.arguments[0];
      const rendered = pack(expression(callback), rows, rowValues);
      const serverCallback = t.arrowFunctionExpression(callback.params.map(param => t.cloneNode(param, true)), t.arrayExpression(rowValues));
      values.push(t.callExpression(t.memberExpression(t.cloneNode(node.callee.object, true), t.identifier('map')), [serverCallback]));
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
    t.returnStatement(template),
  ]));
  const project = t.arrowFunctionExpression([t.identifier(inputName), t.identifier(normalizer)], t.arrayExpression(values));
  return {
    automatic: true,
    minArrayEntries: maps ? 32 : 0,
    displayProjector: generate(project, {comments: false}).code,
    client: generate(t.exportDefaultDeclaration(client), {comments: false}).code,
  };
}
