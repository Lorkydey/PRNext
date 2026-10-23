export function validateWorkerPreload(value){
  if(value===undefined||value===false)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('workerPreload must be false or an object');
  for(const key of Object.keys(value))if(!['routes','maxRssMb','timeoutMs'].includes(key))throw new TypeError(`workerPreload.${key} is not supported`);
  if(!Array.isArray(value.routes)||!value.routes.length||value.routes.length>16||value.routes.some(route=>typeof route!=='string'||!route.startsWith('/')||route.length>1024||/[?#\x00-\x1f]/.test(route))||new Set(value.routes).size!==value.routes.length)throw new TypeError('workerPreload.routes must contain 1 to 16 distinct route patterns');
  const options={routes:value.routes,maxRssMb:value.maxRssMb??256,timeoutMs:value.timeoutMs??5000};
  for(const [key,min,max] of [['maxRssMb',16,2048],['timeoutMs',100,30000]])if(!Number.isInteger(options[key])||options[key]<min||options[key]>max)throw new TypeError(`workerPreload.${key} must be between ${min} and ${max}`);
  return options;
}
