// Qualification may pack unpublished release candidates. Publication retains
// its independent version, registry, provenance and environment checks.
export function qualificationChannel(version) {
  if (typeof version !== 'string') return undefined;
  if (/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) return 'latest';
  if (/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-alpha(?:\.(?:0|[1-9]\d*))?$/.test(version)) return 'alpha';
  if (/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.[1-9]\d*$/.test(version)) return 'next';
}
