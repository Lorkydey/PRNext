'use strict';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length <= 8192;
const values = value => text(value) || Array.isArray(value) && value.length <= 128 && value.every(text);
function validSamples(samples) {
  return Array.isArray(samples) && samples.length > 0 && samples.length <= 32 && Buffer.byteLength(JSON.stringify(samples)) <= 128 * 1024 && samples.every(sample => record(sample) && Object.entries(sample).every(([name,value]) => {
    if (name === 'cookies') return Array.isArray(value) && value.length <= 128 && value.every(item => record(item) && Object.keys(item).every(key=>['name','value'].includes(key)) && text(item.name) && /^[!#$%&'*+.^_`|~\w-]+$/.test(item.name) && (item.value === null || text(item.value)));
    if (name === 'headers') return Array.isArray(value) && value.length <= 128 && value.every(item => Array.isArray(item) && item.length === 2 && text(item[0]) && /^[!#$%&'*+.^_`|~\w-]+$/.test(item[0]) && (item[1] === null || text(item[1]) && !/[\r\n\0]/.test(item[1])));
    if (name === 'params' || name === 'searchParams') return record(value) && Object.keys(value).length <= 128 && Object.entries(value).every(([key,value])=>text(key) && (values(value) || name === 'searchParams' && value === null));
    return false;
  }));
}
function missing(request, kind, name) {
  const error = Object.assign(new Error(`Route ${request.routePattern}: instant.unstable_samples does not declare ${kind} ${JSON.stringify(name)}. Supply a value${kind === 'params' ? '' : ' or null for absence'}.`),{code:'PRNEXT_INSTANT_SAMPLE'});
  if(request.staticState) request.staticState.error ||= error;
  throw error;
}
function sampleMethods(request,kind,target) {
  const sample = request.instantSample;
  const names = new Set((sample[kind] || []).map(item=>kind === 'cookies' ? item.name : item[0].toLowerCase()));
  if(kind === 'headers' && sample.cookies)names.add('cookie');
  return new Proxy(target,{get(value,key){
    const method=Reflect.get(value,key,value);
    if(['get','has','getAll'].includes(key))return argument=>{
      const name=typeof argument === 'object' ? argument.name : argument;
      if(name !== undefined && !names.has(kind === 'headers' ? String(name).toLowerCase() : name))missing(request,kind,name);
      return method.call(value,argument);
    };
    return typeof method === 'function' ? method.bind(value) : method;
  }});
}
function sampleObject(request,kind,values) {
  const declared=request.instantSample[kind] || {};
  return new Proxy(values,{get(target,key,receiver){
    if(typeof key === 'string' && !['then','toJSON'].includes(key) && !Object.hasOwn(declared,key))missing(request,kind,key);
    return Reflect.get(target,key,receiver);
  },has(target,key){if(typeof key==='string'&&!Object.hasOwn(declared,key))missing(request,kind,key);return Reflect.has(target,key);}});
}
module.exports={validSamples,sampleMethods,sampleObject};
