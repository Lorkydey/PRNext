// Ship the reviewed renderer instead of resolving upstream's vulnerable pin.
export async function loadImageRenderer() {
  return import('./og/index.node.mjs');
}
