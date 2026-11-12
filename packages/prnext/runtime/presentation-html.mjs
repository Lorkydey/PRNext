// SSR-only helpers. Inputs are the compiler's already normalized display slots.
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {isProxy} from 'node:util/types';
const entities = {'"':'&quot;',"'":'&#x27;','&':'&amp;','<':'&lt;','>':'&gt;'};
export function escapePresentationHtml(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError('Unexpected HTML display value');
  if(typeof value==='string'&&value.length>262144)throw new RangeError('Presentation HTML field budget');
  return String(value).replace(/["'&<>]/g, value => entities[value]);
}
export function presentationHtmlAttribute(name, value) {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  const alias=name==='className'?'class':name==='htmlFor'?'for':name==='tabIndex'?'tabindex':name;
  return ' '+alias+'="'+escapePresentationHtml(value)+'"';
}
/** Delegate CSS serialization to React once per used literal style, not per row.
 * No shared style/data cache; decoded per-request metadata cannot go stale.
 */
export function presentationHtmlStyle(style) {
  if(style===null||style===undefined)return '';
  if(isProxy(style)||typeof style!=='object'||Object.getPrototypeOf(style)!==Object.prototype)throw new TypeError('Unexpected literal style');
  for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(style))){
    if(!('value'in descriptor)||descriptor.value!==null&&!['string','number','boolean'].includes(typeof descriptor.value))throw new TypeError('Unexpected literal style field');
  }
  const html=renderToStaticMarkup(createElement('div',{style})).slice(4,-7);
  if(html.length>262144)throw new RangeError('Presentation HTML style budget');
  return html;
}
