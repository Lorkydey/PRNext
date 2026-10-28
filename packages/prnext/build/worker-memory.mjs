export function validateWorkerMemory(value) {
  if (value === undefined || value === false) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'maxRssMb') ||
      !Number.isSafeInteger(value.maxRssMb) || value.maxRssMb < 64 || value.maxRssMb > 65536) {
    throw new TypeError('workerMemory must be false or { maxRssMb: 64..65536 }');
  }
  return { maxRssMb: value.maxRssMb };
}
