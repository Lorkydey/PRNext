import test from 'node:test';
import assert from 'node:assert/strict';
import { compactCssModule, globalCssNames } from './compact-css.mjs';

test('compact module classes preserve globals, attributes, composition and animation names', () => {
  const first='r123456789012_very_long_component_primary', second='r234567890123_other_secondary', animation='r123456789012_spin';
  const original = `.${first}:hover,.${second} .global{animation:2s ${animation};content:"${first}"}[data-name="${first}"]{color:red}@keyframes ${animation}{to{opacity:0}}`;
  const result = compactCssModule(original, {button:first+' '+second,spin:animation});
  assert.ok(result.css.length < original.length);
  const [a,b] = result.mapping.button.split(' ');
  assert.match(a,/^p[\w-]{10}$/); assert.notEqual(a,b);
  assert.ok(result.css.includes(`.${a}:hover,.${b} .global`));
  assert.ok(result.css.includes(`2s ${result.mapping.spin}`));
  assert.ok(result.css.includes(`@keyframes ${result.mapping.spin}`));
  assert.ok(result.css.includes(`content:"${first}"`));
  assert.ok(result.css.includes(`[data-name="${first}"]`));
  assert.equal(compactCssModule(original,{spin:animation,button:first+' '+second}).mapping.button,result.mapping.button);
});
test('escaping is parsed, stable independent of other modules and collisions fail closed', () => {
  const result = compactCssModule('.module\\:class{color:red}', {root:'module:class'});
  assert.equal(result.css,`.${result.mapping.root}{color:red}`);
  assert.throws(()=>compactCssModule('.one,.two{}',{one:'one',two:'two'},{hash:()=> 'same'}),/collision/);
});
test('composed global classes and explicit global selectors keep their public names',()=>{
  const globals=globalCssNames(':global(.external),:global .outside{color:red}.local{composes: shared from global}');
  assert.deepEqual([...globals].sort(),['external','outside','shared']);
  const result=compactCssModule('.local .external{color:red}',{root:'local external shared'},{globals});
  assert.equal(result.mapping.root.split(' ').slice(1).join(' '),'external shared');
  assert.ok(result.css.includes(' .external'));
});
