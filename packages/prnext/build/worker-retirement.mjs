export function validateWorkerRetirement(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('workerRetirement must be an object');
  for (const [key, setting] of Object.entries(value)) {
    if (!['idleSeconds', 'laneIdleSeconds', 'keepWarm'].includes(key)) throw new TypeError(`workerRetirement.${key} is not supported`);
    if (setting === undefined) continue;
    if (key === 'keepWarm') {
      if (typeof setting !== 'boolean') throw new TypeError('workerRetirement.keepWarm must be a boolean');
    } else if (!Number.isSafeInteger(setting) || setting < 0 || setting > 604800) {
      throw new TypeError(`workerRetirement.${key} must be an integer between 0 and 604800 seconds (0 disables retirement)`);
    }
  }
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
