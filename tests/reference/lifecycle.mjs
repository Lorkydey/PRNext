export async function referenceDeadline(promise, message, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Promise.race cannot cancel an acquisition. Dispose a resource that arrives
// after the workflow has expired instead of assigning it after cleanup ran.
export async function acquireReferenceResource(acquire, { isClosed, dispose, timeout = 5000 }) {
  if (isClosed()) throw new Error('Reference resource acquisition started after workflow closure.');
  const resource = await acquire();
  if (!isClosed()) return resource;
  await referenceDeadline(Promise.resolve().then(() => dispose(resource)), 'Late reference resource cleanup exceeded its deadline.', timeout);
  throw new Error('Reference resource arrived after workflow closure and was closed.');
}

// A stuck graceful close must not prevent cleanup of the other owned services.
// `force` is supplied only for a process handle created by this fixture.
export async function closeReferenceResources(resources, checkpoint, { checkpointTimeout = 5000 } = {}) {
  const outcomes = [];
  let checkpointFailed = false;
  const save = async outcome => {
    if (!checkpointFailed) {
      try {
        await referenceDeadline(Promise.resolve().then(() => checkpoint(outcomes)), 'Reference cleanup checkpoint exceeded its deadline.', checkpointTimeout);
      } catch { checkpointFailed = true; }
    }
    if (checkpointFailed) outcome.progressPersistenceFailed = true;
  };
  for (const resource of resources) {
    const outcome = { resource: resource.name, phase: 'closing' };
    outcomes.push(outcome);
    await save(outcome);
    try {
      await referenceDeadline(Promise.resolve().then(resource.close), resource.name + ' cleanup exceeded its deadline.', resource.timeout);
      outcome.phase = 'closed';
    } catch {
      outcome.phase = 'graceful-close-failed';
      await save(outcome);
      if (resource.force) {
        try {
          await referenceDeadline(Promise.resolve().then(resource.force), resource.name + ' forced cleanup exceeded its deadline.', resource.timeout);
          outcome.phase = 'force-closed';
        } catch { outcome.phase = 'cleanup-failed'; }
      } else outcome.phase = 'cleanup-failed';
    }
    await save(outcome);
  }
  return outcomes;
}
