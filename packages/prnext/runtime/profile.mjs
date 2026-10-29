import presets from './profiles.json' with { type: 'json' };

export function rscResourceLimits(environment=process.env,production=environment.NODE_ENV!=='development'){
  if(!production||/--max[-_]semi[-_]space[-_]size(?:[=\s]|$)/.test(environment.NODE_OPTIONS||''))return undefined;
  return {maxYoungGenerationSizeMb:runtimeProfile(environment,production).youngGenerationMiB};
}

export function runtimeProfile(environment = process.env, production = environment.NODE_ENV !== 'development') {
  const requested = environment.PRNEXT_PROFILE || (environment.PRNEXT_MEMORY_PROFILE === 'compact' ? 'compact' : 'balanced');
  const name = requested === 'standard' ? 'classic' : requested;
  if (!Object.hasOwn(presets, name)) throw new Error(`Unknown runtime profile ${JSON.stringify(name)}; use ${Object.keys(presets).join(', ')}`);
  const effective = production ? name : 'classic';
  if(production&&environment.PRNEXT_EFFECTIVE_PROFILE){
    let value;
    try{value=JSON.parse(environment.PRNEXT_EFFECTIVE_PROFILE);}catch{throw new Error('Invalid effective runtime profile');}
    const settings=value?.[1],original=presets[effective];
    if(!Array.isArray(value)||value.length!==2||value[0]!==effective||!settings||
      Object.keys(settings).length!==Object.keys(original).length||Object.keys(original).some(key=>!Object.hasOwn(settings,key)||
        (original[key]===null?settings[key]!==null&&(!Number.isSafeInteger(settings[key])||settings[key]<1):typeof original[key]==='boolean'?typeof settings[key]!=='boolean':!Number.isSafeInteger(settings[key])||settings[key]<1||settings[key]>Math.max(512,original[key]))))throw new Error('Invalid effective runtime profile');
    return {name:effective,...settings};
  }
  return { name: effective, ...presets[effective] };
}
