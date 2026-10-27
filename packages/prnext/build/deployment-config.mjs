const defaults=Object.freeze({maxAge:3600,maxGenerations:2,maxBytes:64*1024*1024});
const limits={maxAge:[1,86400],maxGenerations:[1,5],maxBytes:[1024,256*1024*1024]};

/** Retain only bounded, immutable public assets; false revokes all carry-over. */
export function validateDeploymentRetention(value){
  if(value===false)return false;
  if(value===undefined)return {...defaults};
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('deploymentRetention must be false or an object.');
  const output={...defaults};
  for(const key of Reflect.ownKeys(value)){
    if(!Object.hasOwn(limits,key))throw new TypeError(`deploymentRetention.${String(key)} is not supported.`);
    if(value[key]===undefined)continue;
    const [minimum,maximum]=limits[key];
    if(!Number.isSafeInteger(value[key])||value[key]<minimum||value[key]>maximum)throw new TypeError(`deploymentRetention.${key} must be an integer from ${minimum} to ${maximum}.`);
    output[key]=value[key];
  }
  return output;
}
