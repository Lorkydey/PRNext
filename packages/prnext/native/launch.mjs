// A production CLI has nothing to supervise once the native server starts.
// On supported Linux Node releases, replace it instead of retaining a Node heap.
// Keep the portable parent/pipe lifecycle for Windows, older Node, IPC callers
// and instrumentation which may own descriptors or need JS exit handlers.
export function replaceWithNative(binary, args, env, runtime = process) {
  const options = [...(runtime.execArgv || []), env.NODE_OPTIONS || ''].join(' ');
  // Only heap sizing is known not to require the Node launcher's lifetime.
  // Be conservative for all other Node flags, including future diagnostics,
  // loaders, preloads, permissions and signal-triggered reports/snapshots.
  const customRuntime = options.replace(/(?:^|\s)--max[-_](?:semi|old)[-_]space[-_]size(?:=|\s+)\d+(?=\s|$)/g, '').trim();
  if (runtime.platform !== 'linux' || typeof runtime.execve !== 'function'
    || typeof runtime.send === 'function' || env.NODE_V8_COVERAGE || customRuntime) return false;
  // execve keeps stdin/out/err and the PID. No parent pipe is needed: signals
  // reach Rust directly, and its worker pipes still supervise every Node child.
  // The marker also makes an old native binary fail clearly instead of using
  // this lifecycle without the Linux parent-death guard it requires.
  runtime.execve(binary, [binary, ...args, '--cli-exec'], env);
  return true; // Only reached by injected test runtimes; real execve never returns.
}
