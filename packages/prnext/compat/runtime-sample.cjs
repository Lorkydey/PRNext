'use strict';

// Constructed only for opt-in diagnostics. Samples contain numeric runtime
// counters, never application values, request context or allocation stacks.
function createRuntimeSampler() {
  const { PerformanceObserver, performance } = require('node:perf_hooks');
  const { threadId, resourceLimits } = require('node:worker_threads');
  const { getHeapSpaceStatistics } = require('node:v8');
  let count = 0, durationMs = 0, maxPauseMs = 0;
  let previousTime = performance.now();
  let previousLoop = performance.eventLoopUtilization();
  let previousCpu = threadId === 0 ? process.cpuUsage() : undefined;
  const consume = entries => {
    for (const entry of entries) {
      count++;
      durationMs += entry.duration;
      maxPauseMs = Math.max(maxPauseMs, entry.duration);
    }
  };
  const observer = new PerformanceObserver(list => consume(list.getEntries()));
  observer.observe({ entryTypes: ['gc'] });
  return {
    sample() {
      consume(observer.takeRecords());
      const now = performance.now();
      const loop = performance.eventLoopUtilization();
      const eventLoop = performance.eventLoopUtilization(loop, previousLoop);
      const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
      const young = getHeapSpaceStatistics().find(space => space.space_name === 'new_space');
      const value = {
        node: process.version, v8: process.versions.v8, threadId,
        intervalMs: now - previousTime,
        rssBytes: rss, heapUsedBytes: heapUsed, heapTotalBytes: heapTotal,
        externalBytes: external, arrayBufferBytes: arrayBuffers,
        youngSpaceBytes: young?.space_size ?? 0,
        workerLimits: { ...resourceLimits },
        gc: { count, durationMs, maxPauseMs },
        eventLoop,
      };
      // CPU usage is process-wide, including all worker threads. Emit it only
      // in the main isolate so aggregators cannot count the RSC CPU twice.
      if (previousCpu) {
        const cpu = process.cpuUsage();
        value.cpu = { scope: 'process', userMicros: cpu.user - previousCpu.user,
          systemMicros: cpu.system - previousCpu.system };
        previousCpu = cpu;
      }
      previousLoop = loop; previousTime = now;
      count = durationMs = maxPauseMs = 0;
      return value;
    },
    close() { observer.disconnect(); },
  };
}

module.exports = { createRuntimeSampler };
