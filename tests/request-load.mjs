import { setTimeout as delay } from 'node:timers/promises';

// Keep all application requests pending behind the fixture's gate, while
// giving the OS time to accept new TCP connections. This tests concurrent
// admission without depending on the host's kernel listen-backlog size.
export async function startRequestLoad(count, request) {
  const pending = [];
  for (let index = 0; index < count; index++) {
    const operation = Promise.resolve().then(() => request(index)).catch(error => {
      if (error.cause) error.message += ` (${error.cause.code || 'transport'}: ${error.cause.message})`;
      throw error;
    });
    // A failure may arrive before the gate opens; the caller still observes it
    // through Promise.all, without an unrelated unhandledRejection failure.
    operation.catch(() => {});
    pending.push(operation);
    if ((index + 1) % 16 === 0) await delay(10);
  }
  return pending;
}
