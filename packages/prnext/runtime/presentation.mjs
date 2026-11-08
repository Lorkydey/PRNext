// Shared only by generated RSC wrappers, never imported by browser entries.
// Only statically observed display fields cross the Flight boundary. Do not
// inspect/copy unused fields, invoke getters or serialize opaque application data.
import {isProxy} from 'node:util/types';

const own = Object.getOwnPropertyDescriptor;
const arrayMap = Array.prototype.map;
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const rejected = Symbol('ordinary server render');
const projectors = new WeakMap();

export function projectPresentationProps(props, schema) {
  let projector = projectors.get(schema);
  if (!projector) { projector = createPresentationProjector(schema); projectors.set(schema, projector); }
  return projector(props);
}

/** Compile traversal once per module, without eval or per-row schema/key walks. */
export function createPresentationProjector(schema) {
  function read(object, name) {
    const descriptor = own(object, name);
    if (!descriptor) {
      if (name in Object.prototype) throw rejected;
      return undefined;
    }
    if (!('value' in descriptor)) throw rejected;
    return descriptor.value;
  }
  function compile(shape, depth = 0) {
    if (depth > 32) throw new TypeError('Presentation schema exceeds the depth limit');
    if (shape.kind === 'discard') return () => null;
    if (shape.kind === 'scalar') {
      return (value, budget) => {
        if (--budget.remaining < 0) throw rejected;
        if (shape.boolean && typeof value !== 'boolean') throw rejected;
        if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
        throw rejected;
      };
    }
    if (shape.kind === 'array') {
      const item = compile(shape.item, depth + 1);
      return (value, budget) => {
        if (--budget.remaining < 0 || isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Array.prototype.map !== arrayMap || value.length > 20000 || own(value, 'map')) throw rejected;
        const result = new Array(value.length);
        for (let index = 0; index < value.length; index++) {
          const descriptor = own(value, index);
          // Sparse arrays and accessors retain their exact ordinary React path.
          if (!descriptor || !('value' in descriptor)) throw rejected;
          result[index] = item(descriptor.value, budget);
        }
        return result;
      };
    }
    if (shape.kind !== 'object') throw new TypeError('Invalid presentation schema');
    const fields = Object.keys(shape.fields).map(name => {
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') throw new TypeError('Unsafe presentation field');
      return [name, compile(shape.fields[name], depth + 1)];
    });
    return (value, budget) => {
      if (--budget.remaining < 0 || isProxy(value) || !plain(value)) throw rejected;
      const result = new Array(fields.length);
      for (let index = 0; index < fields.length; index++) {
        const [name, project] = fields[index];
        result[index] = project(read(value, name), budget);
      }
      return result;
    };
  }
  const project = compile(schema);
  return props => {
    try { return project(props, {remaining: 100000}); }
    catch { return null; }
  };
}
