let referenceFactory;
let transport;

// App bootstrap installs the official Flight client after its module loader is
// ready. Action proxy modules load through that same client graph afterwards.
export function configureServerActions({ createServerReference, callServer }) {
  referenceFactory = createServerReference;
  transport = callServer;
}

export function callServer(id, args) {
  if (!transport) return Promise.reject(new Error('The PRNext Server Action transport is not initialized'));
  return transport(id, args);
}

export function createServerReference(id) {
  if (!referenceFactory) throw new Error('Server Action references must load after the PRNext Flight client');
  return referenceFactory(id, callServer);
}
