// A newly opened route can move this helper into a different development ESM
// chunk. Its action proxies still belong to the already mounted application.
// Production keeps the ordinary per-graph module state.
const state = process.env.NODE_ENV === 'development'
  ? globalThis[Symbol.for('prnext.development.server-actions')] ||= {}
  : {};

// App bootstrap installs the official Flight client after its module loader is
// ready. Action proxy modules load through that same client graph afterwards.
export function configureServerActions({ createServerReference, callServer }) {
  state.referenceFactory = createServerReference;
  state.transport = callServer;
}

export function callServer(id, args) {
  const transport = state.transport;
  if (!transport) return Promise.reject(new Error('The PRNext Server Action transport is not initialized'));
  return transport(id, args);
}

export function createServerReference(id) {
  const referenceFactory = state.referenceFactory;
  if (!referenceFactory) throw new Error('Server Action references must load after the PRNext Flight client');
  return referenceFactory(id, callServer);
}
