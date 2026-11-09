import * as t from '@babel/types';

export const presentationSvgTags = new Set('svg g path circle ellipse line polyline polygon rect title desc'.split(' '));
export const presentationSvgAttributes = new Set('width height viewBox fill stroke strokeWidth strokeLinecap strokeLinejoin strokeMiterlimit strokeDasharray strokeDashoffset fillRule clipRule fillOpacity strokeOpacity opacity d cx cy r rx ry x x1 x2 y y1 y2 points transform xmlns preserveAspectRatio'.split(' '));
// Deliberately no use/image/foreignObject/animation, URL attributes or dynamic
// expressions. Source validation executes no application code.
export function staticPresentationSvg(node, depth = 0) {
  if (depth > 32) return false;
  if (t.isJSXText(node)) return true;
  if (t.isJSXExpressionContainer(node)) return t.isJSXEmptyExpression(node.expression) || ['StringLiteral','NumericLiteral','BooleanLiteral','NullLiteral'].includes(node.expression.type);
  if (!t.isJSXElement(node) || !t.isJSXIdentifier(node.openingElement.name) || !presentationSvgTags.has(node.openingElement.name.name)) return false;
  for (const a of node.openingElement.attributes) {
    if (!t.isJSXAttribute(a) || !t.isJSXIdentifier(a.name) || !(presentationSvgAttributes.has(a.name.name) || ['className','role','id','key'].includes(a.name.name) || /^(data|aria)-[\w.-]+$/.test(a.name.name))) return false;
    const value = t.isJSXExpressionContainer(a.value) ? a.value.expression : a.value;
    if (value && !['StringLiteral','NumericLiteral','BooleanLiteral','NullLiteral'].includes(value.type)) return false;
  }
  return node.children.every(child => staticPresentationSvg(child, depth + 1));
}
