const HEADER = 'x-prnext-deployment-id';

/** A generation is an artifact identity, independent from a user-supplied buildId. */
export function deploymentHeaders(id) { return id ? { [HEADER]: id } : {}; }

export async function assertDeploymentResponse(response, expected) {
  if (!expected) return;
  if (response.headers.get(HEADER) === expected && response.status !== 409) return;
  await response.body?.cancel().catch(() => {});
  const error = new Error('This page belongs to a previous deployment. Reload the page before continuing.');
  error.code = 'PRNEXT_DEPLOYMENT_CHANGED';
  throw error;
}
