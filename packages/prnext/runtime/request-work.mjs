// Track the actual application promise as well as the HTTP wrapper. A wrapper
// can reject on abort while npm code keeps running and retaining its context.
export const requestWork = Symbol.for('prnext.request-work');
export function trackRequestWork(promise, signal, options) {
  signal?.[requestWork]?.(promise, options);
  return promise;
}
