import presets from './profiles.json' with { type: 'json' };

export function runtimeProfile(environment = process.env, production = environment.NODE_ENV !== 'development') {
  const requested = environment.PRNEXT_PROFILE || (environment.PRNEXT_MEMORY_PROFILE === 'compact' ? 'compact' : 'balanced');
  const name = requested === 'standard' ? 'classic' : requested;
  if (!Object.hasOwn(presets, name)) throw new Error(`Unknown runtime profile ${JSON.stringify(name)}; use ${Object.keys(presets).join(', ')}`);
  const effective = production ? name : 'classic';
  return { name: effective, ...presets[effective] };
}
