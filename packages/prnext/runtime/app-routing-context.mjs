import React from 'react';
import { renderToReadableStream } from 'react-server-dom-webpack/server.node';
import { createFromReadableStream } from 'react-server-dom-webpack/client.edge';
import { runRequestContext } from '../compat/headers.cjs';
import { flightConsumer } from './cache-components-rsc.mjs';

/** A separate React render preserves AsyncLocalStorage for every nested Server
 * Component, including async descendants and components imported by packages.
 * Merely wrapping a layout function in ALS does not isolate its descendants. */
export function routingBranchRenderer(context, bundler, signal, errorDigest, byteLimit = 16 * 1024 * 1024) {
  const consumer = { serverConsumerManifest: flightConsumer(context), replayConsoleLogs: false };
  const abort = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  let bytes = 0;
  function bounded(stream) {
    return stream.pipeThrough(new TransformStream({ transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > byteLimit) {
        const error = new Error('Combined routing branch Flight exceeds the 16 MiB rendering limit');
        abort.abort(error);
        throw error;
      }
      controller.enqueue(chunk);
    } }));
  }
  return (tree, branch) => {
    async function RoutingBranch() {
      return runRequestContext({ ...context, ...branch, signal: combinedSignal, privateCache: undefined, privateCacheBytes: 0, draftProvider: undefined }, () => {
        const stream = renderToReadableStream(tree, bundler, { signal: combinedSignal, onError: errorDigest });
        return createFromReadableStream(bounded(stream), consumer);
      });
    }
    return React.createElement(RoutingBranch);
  };
}
