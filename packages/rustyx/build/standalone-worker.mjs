import { parentPort, workerData } from 'node:worker_threads';
import { createStandalone } from './standalone.mjs';

try { await createStandalone(workerData); parentPort.postMessage({ ok: true }); }
catch (error) { parentPort.postMessage({ error: { message: error.message, stack: error.stack } }); }
