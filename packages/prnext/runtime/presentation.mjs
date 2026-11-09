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
export function createPresentationProjector(schema, {minArrayEntries = 0} = {}) {
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
        if (--budget.remaining < 0 || isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || own(Array.prototype, 'map')?.value !== arrayMap || value.length > 20000 || own(value, 'map')) throw rejected;
        budget.entries += value.length;
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
    try {
      const budget = {remaining:100000, entries:0};
      const result = project(props, budget);
      return budget.entries < minArrayEntries ? null : result;
    }
    catch { return null; }
  };
}

function displayValue(value, kind) {
  if (value !== null && value !== undefined && !['string','boolean','number'].includes(typeof value)) throw rejected;
  if (kind === 'key') return value === undefined ? undefined : String(value);
  if (value === null || value === undefined || typeof value === 'boolean' && kind !== 'attribute') return null;
  if (kind === 'text' && typeof value === 'number') return value === 0 ? 0 : value;
  return String(value);
}

/** The generated display projector runs only over validated, owned scalar
 * tuples. No getters/application callbacks run, and only observable leaf values
 * cross Flight. Keep operators, branch inputs and original source on the server.
 */
export function createAutomaticPresentationProjector(input, display) {
  return props => {
    const packed = input(props);
    if (packed === null) return null;
    try { return display(packed, displayValue); }
    catch { return null; }
  };
}

/** Validate source descriptors and emit final display rows in one traversal.
 * No intermediate input tuple tree, eval, getters, proxies or application
 * callbacks. The display function is generated from the compiler's pure subset.
 * Nested arrays are checked when their generated map is actually evaluated.
 */
export function createFusedPresentationProjector(schema, arraySchemas, display, {minArrayEntries = 0,literals=[],packet=false,inlineValidation=false} = {}) {
  function array(value) {
    if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      own(Array.prototype, 'map')?.value !== arrayMap || value.length > 20000 || own(value, 'map')) throw rejected;
  }
  function compile(shape, depth = 0) {
    if (depth > 32) throw new TypeError('Presentation schema exceeds the depth limit');
    if (shape.kind === 'discard') return () => {};
    if (shape.kind === 'scalar') return (value, budget) => {
      if (--budget.remaining < 0 || shape.boolean && typeof value !== 'boolean') throw rejected;
      if (value !== null && value !== undefined && typeof value !== 'string' && typeof value !== 'boolean' &&
        !(typeof value === 'number' && Number.isFinite(value))) throw rejected;
    };
    if (shape.kind === 'array') return (value, budget) => {
      if (--budget.remaining < 0) throw rejected;
      array(value);
    };
    if (shape.kind !== 'object') throw new TypeError('Invalid presentation schema');
    const fields = Object.entries(shape.fields).map(([name, child]) => {
      if (['__proto__','constructor','prototype'].includes(name)) throw new TypeError('Unsafe presentation field');
      return [name, compile(child, depth + 1)];
    });
    return (value, budget) => {
      if (--budget.remaining < 0 || isProxy(value) || !plain(value)) throw rejected;
      for (let index = 0; index < fields.length; index++) {
        const [name, check] = fields[index], descriptor = own(value, name);
        if (descriptor ? !('value' in descriptor) : name in Object.prototype) throw rejected;
        check(descriptor?.value, budget);
      }
    };
  }
  const validate = compile(schema), items = arraySchemas.map(shape => compile(shape));
  const object=value=>{if(isProxy(value)||!plain(value))throw rejected;};
  return props => {
    const budget = {remaining: 100000, entries: 0};
    const used=packet?new Array(literals.length).fill(null):undefined;
    const guards={own,prototype:Object.prototype,rejected,finite:Number.isFinite,object,array,
      reserve(count){budget.remaining-=count;if(budget.remaining<0)throw rejected;},
    };
    try {
      validate(props, budget);
      const result = display(props, displayValue, (index, value, callback) => {
        const check = items[index];
        if (!check || --budget.remaining < 0) throw rejected;
        array(value); budget.entries += value.length;
        if(arraySchemas.length===1&&value.length<minArrayEntries)throw rejected;
        const rows = new Array(value.length);
        for (let row = 0; row < value.length; row++) {
          const descriptor = own(value, row);
          if (!descriptor || !('value' in descriptor)) throw rejected;
          if(!inlineValidation)check(descriptor.value, budget);
          rows[row] = callback(descriptor.value, row);
        }
        return rows;
      },index=>{if(packet){if(!Number.isSafeInteger(index)||index<0||index>=literals.length)throw rejected;used[index]=literals[index];}},guards);
      return budget.entries < minArrayEntries ? null : packet?{data:result,literals:used}:result;
    } catch { return null; }
  };
}
