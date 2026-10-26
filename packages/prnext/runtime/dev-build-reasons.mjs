const messages={
  'initial-build':'Compile the requested routes.',
  'route-opened':'Compile a newly opened route.',
  'source-changed':'Source files changed.',
  'environment-changed':'Environment variables changed; restart the compiler.',
  'configuration-changed':'Build configuration changed; rebuild the active routes.',
  'safe-mode':'Safe mode uses a fresh compiler and the complete route graph.',
  'unknown-dependency':'A changed file is outside the dependency index; refresh all active routes.',
  'dependency-capacity':'The affected graph exceeds the selective-update budget; rebuild all active routes.',
  'missing-style-dependencies':'This build has no per-bundle style graph; rebuild styles and JavaScript together.',
  'css-only':'Update styles without replacing the application worker.',
  'css-module-exports':'CSS Module exports changed; rebuild JavaScript and styles together.',
  'css-processor':'Custom CSS processing requires a complete build.',
  'stylesheet-language':'This stylesheet requires the complete compiler.',
  'unknown-style-dependency':'A stylesheet is outside the recorded style graph.',
  'external-asset-base':'External asset URLs require a complete build.',
  'outside-active-graph':'Keep this unopened route uncompiled until it is requested.',
};
export function devBuildReason({initial=false,safe=false,changed=[],cause}={}){
  const code=safe?'safe-mode':initial?'initial-build':
    changed.some(file=>/(?:^|\/)\.env(?:\.|$)/.test(file))?'environment-changed':
    changed.some(file=>/(?:^|\/)(?:(?:prnext|next|postcss|tsconfig|jsconfig)\.config\.|(?:tsconfig|jsconfig)\.json$|package(?:-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$)/.test(file))?'configuration-changed':
    cause&&messages[cause]?cause:changed.length?'source-changed':'route-opened';
  return {code,summary:messages[code]};
}
