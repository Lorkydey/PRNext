import { createServerReference as createReference } from 'react-server-dom-webpack/client.node';

// The official proxy carries React's form action and useActionState signatures.
// Invoking it during SSR is rejected by React instead of running a mutation.
export function createServerReference(id) { return createReference(id); }
