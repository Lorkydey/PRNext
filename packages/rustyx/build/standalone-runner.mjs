import { Worker } from 'node:worker_threads';

// Prerender installs Flight's webpack shims. NFT's native-loader discovery must
// see ordinary Node globals, so tracing runs in its own short-lived isolate.
export async function prepareStandalone(options) {
  const { output, distDir, outputFileTracingRoot, outputFileTracingIncludes, outputFileTracingExcludes } = options.config;
  const worker = new Worker(new URL('./standalone-worker.mjs', import.meta.url), {
    workerData: { ...options, config: { output, distDir, outputFileTracingRoot, outputFileTracingIncludes, outputFileTracingExcludes } },
    execArgv: process.execArgv.filter(argument => !argument.startsWith('--input-type')),
  });
  try {
    await new Promise((resolve, reject) => {
      worker.once('message', message => {
        if (message.ok) resolve();
        else { const error = new Error(message.error?.message || 'Standalone preparation failed'); if (message.error?.stack) error.stack = message.error.stack; reject(error); }
      });
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`Standalone preparation exited before completion (${code})`)));
    });
  } finally { await worker.terminate(); }
}
