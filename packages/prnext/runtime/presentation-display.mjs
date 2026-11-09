// Universal, bounded renderer for compiler-verified display plans. No React,
// Node APIs, application callbacks, eval, or shared request data.
import {presentationPacketReader} from './presentation-packet.mjs';

const entities = {'"':'&quot;',"'":'&#x27;','&':'&amp;','<':'&lt;','>':'&gt;'};
const aliases = {className:'class',htmlFor:'for',tabIndex:'tabindex',strokeWidth:'stroke-width',strokeLinecap:'stroke-linecap',strokeLinejoin:'stroke-linejoin',strokeMiterlimit:'stroke-miterlimit',strokeDasharray:'stroke-dasharray',strokeDashoffset:'stroke-dashoffset',fillRule:'fill-rule',clipRule:'clip-rule',fillOpacity:'fill-opacity',strokeOpacity:'stroke-opacity'};
export const displayAttributeName = name => aliases[name] || name;
export const displayText = value => value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
export function escapeDisplay(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError('Display scalar expected');
  const text = String(value);
  if (text.length > 262144) throw new RangeError('Display field budget');
  return text.replace(/["'&<>]/g, value => entities[value]);
}
export function displayValue(ref, scope) {
  if (ref[0] === 'l') return scope.literals[ref[1]];
  if (ref[0] === 's') return ref[1];
  return scope.reader.at(scope.offsets[ref[1]] + ref[2]);
}
export function displayScope(packet, literals) {
  return {reader:presentationPacketReader(packet),literals,offsets:[0],remaining:100000};
}
export function displayList(ir, scope) {
  const pointer = displayValue(ir[1], scope), count = scope.reader.at(pointer), width = scope.reader.at(pointer + 1);
  if (!Number.isSafeInteger(count) || count < 0 || count > 20000 || width !== ir[3]) throw new RangeError('Display list layout');
  scope.reader.range(pointer + 2, count * width);
  return {start:pointer + 2,count,width};
}
export function displayBranch(ir, scope) {
  const pointer = displayValue(ir[1], scope), choice = scope.reader.at(pointer);
  if (choice !== 0 && choice !== 1) throw new TypeError('Display branch selector');
  scope.offsets[ir[2]] = pointer;
  return ir[3][choice];
}
export function displayKey(ref, scope, index) {
  const key = ref ? displayValue(ref, scope) : undefined;
  return key === undefined ? index : 'k:' + String(key);
}
export function displayProps(attributes, scope) {
  const props = {};
  for (const [name, value] of attributes) if (name !== 'key') props[name] = displayValue(value, scope);
  return props;
}

/** Consume the flat/binary display packet directly, without rebuilding row
 * arrays or allocating React elements. Outer routing/Flight decoding is still
 * owned by React; this shortcut is local to verified presentation blocks.
 */
export function renderPresentationDisplay(plan, packet, literals,writer) {
  const scope = displayScope(packet, literals);
  let html = '', adjacentText = false;
  function append(value) {
    html += value;
    if (html.length > 4194304) throw new RangeError('Display HTML budget');
  }
  function emit(ir) {
    if (--scope.remaining < 0) throw new RangeError('Display node budget');
    if (ir[0] === 't') {
      const value = displayText(displayValue(ir[1], scope));
      if (value !== '') { if (adjacentText) append('<!-- -->'); append(escapeDisplay(value)); adjacentText = true; }
    } else if (ir[0] === 'e') {
      append('<' + ir[1]);
      for (const [name, ref, css] of ir[2]) {
        if (name === 'key') continue;
        const value = displayValue(css || ref, scope);
        if (value !== null && value !== undefined && typeof value !== 'boolean' && !(name === 'style' && value === '')) append(' ' + displayAttributeName(name) + '="' + escapeDisplay(value) + '"');
      }
      append('>'); adjacentText = false;
      for (const child of ir[3]) emit(child);
      append('</' + ir[1] + '>'); adjacentText = false;
    } else if (ir[0] === 'f') {
      for (const child of ir[1]) emit(child);
    } else if (ir[0] === 'c') emit(displayBranch(ir, scope));
    else if (ir[0] === 'r') {
      const list = displayList(ir, scope), keys = new Set();
      for (let i = 0; i < list.count; i++) {
        scope.offsets[ir[2]] = list.start + i * list.width;
        const key = displayKey(ir[5], scope, i);
        if (keys.has(key)) throw new TypeError('Duplicate display keys retain ordinary React rendering');
        keys.add(key); emit(ir[4]);
      }
    } else throw new TypeError('Invalid display instruction');
  }
  const root = plan.root;
  scope.reader.range(0, plan.width);
  if(writer)return{html:writer(scope,escapeDisplay),props:displayProps(root[2],scope)};
  for (const child of root[3]) emit(child);
  return {html,props:displayProps(root[2], scope)};
}
