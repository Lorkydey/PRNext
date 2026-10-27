import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';

const reports = new AsyncLocalStorage(), graphs = new AsyncLocalStorage();
const FILE_LIMIT = 1024, FUNCTION_LIMIT = 4096, EVENT_LIMIT = 16, TOTAL_EVENT_LIMIT = 8192;
const GRAPH_INPUT_LIMIT = 4096;
const REPORT_LIMIT = 8 * 1024 * 1024;
export const REACT_COMPILER_REPORT_FILE = 'react-compiler-report.json';
const statuses = new Set(['optimized', 'skipped', 'error', 'diagnostic', 'mixed']);
const kinds = new Set(['CompileSuccess', 'CompileSkip', 'CompileError', 'CompileDiagnostic', 'PipelineError']);
const slash = value => value.split(path.sep).join('/');
const position = value => value && Number.isSafeInteger(value.line) && value.line > 0 && Number.isSafeInteger(value.column) && value.column >= 0
  ? { line: value.line, column: value.column } : null;
function text(value, root = '') {
  if (typeof value !== 'string') return null;
  return value.replaceAll(root || '\0', '<project>').replace(/https?:\/\/\S+/g, '')
    .replace(/(?:file:\/\/\/)?[A-Za-z]:[\\/][^\s'")]+/g, '<path>')
    .replace(/(?:^|\s)\/(?:[^\s/'"]+\/)+[^\s'")]+/g, ' <path>')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 384) || null;
}
function relativeFile(root, file) {
  if (typeof root !== 'string' || typeof file !== 'string') return null;
  const relative = path.relative(root, file);
  return !relative || relative.length > 1024 || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ? null : slash(relative);
}

/** Each build owns its collector. Failed/overlapping rebuilds cannot replace it. */
export const withReactCompilerReporting = run => reports.run({ files: new Map(), graphs: new Map(), functionCount: 0, eventCount: 0, truncated: false }, run);
export function configureReactCompilerReporting({ root, config, buildId, dev, compilerVersion }) {
  const state = reports.getStore();
  if (state) Object.assign(state, { root: path.resolve(root), enabled: !!config?.reactCompiler,
    options: config?.reactCompiler || null, buildId, dev: !!dev, compilerVersion });
}
export const withReactCompilerGraph = (target, run) => graphs.run(target, run);

/** Capture a narrow, source-free subset of the pinned compiler's public events. */
export function compilerEvent(event, functions, { moduleOptOut = false, root = '' } = {}) {
  if (!event || !kinds.has(event.kind)) return null;
  const start = position(event.fnLoc?.start), end = position(event.fnLoc?.end);
  const contains = fn => start && fn.start && fn.end && (fn.start.line < start.line || fn.start.line === start.line && fn.start.column <= start.column)
    && (fn.end.line > start.line || fn.end.line === start.line && fn.end.column >= start.column);
  const fn = functions.filter(contains).sort((a, b) => b.start.line - a.start.line || b.start.column - a.start.column)[0];
  const detail = event.detail?.options || event.detail;
  let status = event.kind === 'CompileSuccess' ? 'optimized' : event.kind === 'CompileSkip' ? 'skipped'
    : event.kind === 'CompileDiagnostic' ? 'diagnostic' : 'error';
  let reason = event.kind === 'PipelineError' ? 'React Compiler could not complete this function.' : text(event.reason ?? detail?.reason, root);
  let category = text(detail?.category, root), policy = false;
  // Compiler 1.0.0 emits CompileSuccess even when its module opt-out prevents
  // emitting the compiled function. Success is not proof of emitted memoization.
  if (moduleOptOut && event.kind === 'CompileSuccess') {
    status = 'skipped'; reason = `Module uses "${moduleOptOut === true ? 'use no memo' : moduleOptOut}".`; category = 'Directive'; policy = true;
  } else if (event.kind === 'CompileSkip' && fn?.optOut) {
    reason = `Function uses "${fn.optOut === true ? 'use no memo' : fn.optOut}".`; category = 'Directive'; policy = true;
  }
  const output = { kind: event.kind, status, name: text(fn?.name || event.fnName, root),
    start: fn?.start || start, end: fn?.end || end, reason, category, policy };
  if (status === 'optimized') for (const key of ['memoSlots', 'memoBlocks', 'memoValues']) {
    if (Number.isSafeInteger(event[key]) && event[key] >= 0) output[key] = event[key];
  }
  return output;
}

/** Cache payloads contain code and these immutable event values, never ASTs. */
export function recordReactCompilerTransform(file, payload, { cacheHit = false } = {}) {
  const state = reports.getStore();
  if (!state?.enabled) return;
  const relative = relativeFile(state.root, file);
  if (!relative) return;
  if (!state.files.has(relative) && state.files.size >= FILE_LIMIT) { state.truncated = true; return; }
  let record = state.files.get(relative);
  if (!record) state.files.set(relative, record = { file: relative, transforms: 0, cacheReuses: 0,
    targets: new Set(), notes: new Set(), functions: new Map() });
  record.transforms++; record.cacheReuses += Number(cacheHit);
  const target = graphs.getStore() || 'unspecified';
  record.targets.add(target);
  for (const note of payload.notes || []) record.notes.add(note);
  for (const event of payload.events || []) {
    const key = JSON.stringify([event.start, event.name]);
    let fn = record.functions.get(key);
    if (!fn) {
      if (state.functionCount >= FUNCTION_LIMIT) { state.truncated = true; continue; }
      record.functions.set(key, fn = { name: event.name, start: event.start, end: event.end,
        statuses: new Set(), targets: new Set(), events: new Map() });
      state.functionCount++;
    }
    fn.statuses.add(event.status); fn.targets.add(target);
    const detail = { kind: event.kind, status: event.status, reason: event.reason, category: event.category,
      ...(event.policy ? { policy: true } : {}), ...Object.fromEntries(['memoSlots', 'memoBlocks', 'memoValues']
        .filter(key => event[key] !== undefined).map(key => [key, event[key]])) };
    const detailKey = JSON.stringify(detail);
    if (fn.events.has(detailKey)) { fn.events.get(detailKey).targets.add(target); continue; }
    if (fn.events.size < EVENT_LIMIT && state.eventCount < TOTAL_EVENT_LIMIT) { fn.events.set(detailKey, { ...detail, targets: new Set([target]) }); state.eventCount++; }
    else state.truncated = true;
  }
  if (payload.truncated) state.truncated = true;
}
export function recordReactCompilerGraph(result) {
  const state = reports.getStore(), target = graphs.getStore();
  if (!state?.enabled || !target) return;
  let record = state.graphs.get(target);
  if (!record) state.graphs.set(target, record = { target, inputs: new Set(), metadataAvailable: true });
  if (!result?.metafile?.inputs) { record.metadataAvailable = false; return; }
  for (const file of Object.keys(result.metafile.inputs)) {
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file)) continue;
    const relative = relativeFile(state.root, path.resolve(state.root, file));
    if (relative && !relative.split('/').some(part => part === 'node_modules' || part.startsWith('.prnext'))) {
      if (record.inputs.size < GRAPH_INPUT_LIMIT || record.inputs.has(relative)) record.inputs.add(relative);
      else { state.truncated = true; record.metadataAvailable = false; }
    }
  }
}
export function reactCompilerReport() {
  const state = reports.getStore();
  if (!state) return null;
  const files = [...state.files.values()].sort((a, b) => a.file.localeCompare(b.file)).map(file => ({
    file: file.file, transforms: file.transforms, cacheReuses: file.cacheReuses, targets: [...file.targets].sort(), notes: [...file.notes].sort(),
    functions: [...file.functions.values()].map(fn => ({ name: fn.name, start: fn.start, end: fn.end,
      status: fn.statuses.size === 1 ? [...fn.statuses][0] : 'mixed', targets: [...fn.targets].sort(),
      events: [...fn.events.values()].map(({ targets, ...event }) => ({ ...event, targets: [...targets].sort() })) }))
      .sort((a, b) => (a.start?.line || 0) - (b.start?.line || 0) || (a.start?.column || 0) - (b.start?.column || 0)),
  }));
  const summary = summarize(files);
  return { version: 1, compilerVersion: state.compilerVersion || null, enabled: !!state.enabled,
    buildId: state.buildId || null, mode: state.dev ? 'development' : 'production', scope: 'observed-transforms',
    options: state.enabled ? state.options : null, truncated: state.truncated, summary, files,
    graphs: [...state.graphs.values()].map(graph => ({ target: graph.target, metadataAvailable: graph.metadataAvailable,
      projectJavaScriptInputs: graph.inputs.size, observedFiles: files.filter(file => file.targets.includes(graph.target)).length,
      unobservedInputs: [...graph.inputs].filter(file => !state.files.get(file)?.targets.has(graph.target)).length })),
  };
}

export async function writeReactCompilerReport(directory, report = reactCompilerReport()) {
  if (!report) return null;
  let serialized = JSON.stringify(report) + '\n';
  // Developer diagnostics must never make an otherwise valid large app fail.
  while (Buffer.byteLength(serialized) > REPORT_LIMIT && report.files.length) {
    const files = report.files.slice(0, Math.floor(report.files.length / 2));
    report = { ...report, truncated: true, files, summary: summarize(files), graphs: report.graphs.map(graph => ({ ...graph,
      metadataAvailable: false, observedFiles: files.filter(file => file.targets.includes(graph.target)).length,
      unobservedInputs: graph.projectJavaScriptInputs })) };
    serialized = JSON.stringify(report) + '\n';
  }
  if (Buffer.byteLength(serialized) > REPORT_LIMIT) throw new Error('Invalid React Compiler report metadata.');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, REACT_COMPILER_REPORT_FILE), serialized);
  return report;
}
export async function readReactCompilerReport(directory, { buildId } = {}) {
  let serialized, handle;
  try {
    handle = await open(path.join(directory, REACT_COMPILER_REPORT_FILE), 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > REPORT_LIMIT) throw new Error('Invalid React Compiler report: size limit exceeded.');
    const buffer = Buffer.alloc(Math.min(stat.size + 1, REPORT_LIMIT + 1));
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    // A concurrently growing/replaced report is not a successful build artifact.
    if (length > stat.size || (await handle.stat()).size !== stat.size) throw new Error('Invalid or stale React Compiler report. Rebuild the application.');
    serialized = buffer.subarray(0, length);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
  let value;
  try { value = JSON.parse(serialized); } catch { throw new Error('Invalid React Compiler report JSON.'); }
  if (!validReport(value) || buildId !== undefined && value.buildId !== buildId) throw new Error('Invalid or stale React Compiler report. Rebuild the application.');
  return value;
}
function validReport(report) {
  const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
  const safePath = file => typeof file === 'string' && file.length <= 1024 && !file.includes('\\') && !/[\u0000-\u001f\u007f]/.test(file)
    && !path.posix.isAbsolute(file) && !/^[A-Za-z]:/.test(file) && file.split('/').every(part => part && part !== '.' && part !== '..');
  const boundedText = value => value === null || typeof value === 'string' && value.length <= 384 && !/[\u0000-\u001f\u007f]/.test(value);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const targets = value => Array.isArray(value) && value.length <= 4 && value.every(target => ['browser', 'node', 'edge', 'unspecified'].includes(target));
  const validPosition = value => value === null || keys(value, ['line', 'column']) && !!position(value);
  const options = report?.options;
  const validOptions = options === null || options === true || keys(options, ['compilationMode', 'panicThreshold', 'target'])
    && ['infer', 'annotation'].includes(options.compilationMode) && ['none', 'critical_errors', 'all_errors'].includes(options.panicThreshold) && options.target === '19';
  return keys(report, ['version', 'compilerVersion', 'enabled', 'buildId', 'mode', 'scope', 'options', 'truncated', 'summary', 'files', 'graphs'])
    && report.version === 1 && report.scope === 'observed-transforms' && typeof report.enabled === 'boolean' && validOptions
    && typeof report.truncated === 'boolean' && ['development', 'production'].includes(report.mode)
    && boundedText(report.buildId) && boundedText(report.compilerVersion)
    && keys(report.summary, ['files', 'functions', 'optimized', 'skipped', 'errors', 'diagnostics', 'mixed', 'transforms', 'cacheReuses'])
    && ['files', 'functions', 'optimized', 'skipped', 'errors', 'diagnostics', 'mixed', 'transforms', 'cacheReuses'].every(key => count(report.summary[key]))
    && Array.isArray(report.files) && report.files.length <= FILE_LIMIT && report.summary.files === report.files.length
    && report.files.every(file => file && typeof file === 'object')
    && new Set(report.files.map(file => file.file)).size === report.files.length
    && report.files.every(file => keys(file, ['file', 'transforms', 'cacheReuses', 'targets', 'notes', 'functions'])
      && safePath(file.file) && count(file.transforms) && count(file.cacheReuses) && file.cacheReuses <= file.transforms && targets(file.targets)
      && Array.isArray(file.notes) && file.notes.length <= 16 && file.notes.every(boundedText)
      && Array.isArray(file.functions) && file.functions.length <= FUNCTION_LIMIT && file.functions.every(fn => keys(fn, ['name', 'start', 'end', 'status', 'targets', 'events'])
        && boundedText(fn.name) && statuses.has(fn.status) && validPosition(fn.start) && validPosition(fn.end) && targets(fn.targets)
        && Array.isArray(fn.events) && fn.events.length <= EVENT_LIMIT && fn.events.every(event => keys(event, ['kind', 'status', 'reason', 'category', 'policy', 'memoSlots', 'memoBlocks', 'memoValues', 'targets'])
          && kinds.has(event.kind) && statuses.has(event.status) && boundedText(event.reason) && boundedText(event.category) && targets(event.targets)
          && (event.policy === undefined || typeof event.policy === 'boolean')
          && ['memoSlots', 'memoBlocks', 'memoValues'].every(key => event[key] === undefined || count(event[key])))))
    && report.files.reduce((sum, file) => sum + file.functions.length, 0) <= FUNCTION_LIMIT
    && Object.entries(summarize(report.files)).every(([key, value]) => report.summary[key] === value)
    && (!report.enabled ? report.files.length === 0 && options === null : options !== null)
    && Array.isArray(report.graphs) && report.graphs.length <= 4 && report.graphs.every(graph => keys(graph, ['target', 'metadataAvailable', 'projectJavaScriptInputs', 'observedFiles', 'unobservedInputs'])
      && targets([graph.target]) && typeof graph.metadataAvailable === 'boolean' && ['projectJavaScriptInputs', 'observedFiles', 'unobservedInputs'].every(key => count(graph[key]))
      && graph.unobservedInputs <= graph.projectJavaScriptInputs);
}
function summarize(files) {
  const summary = { files: files.length, functions: 0, optimized: 0, skipped: 0, errors: 0, diagnostics: 0, mixed: 0, transforms: 0, cacheReuses: 0 };
  for (const file of files) { summary.transforms += file.transforms; summary.cacheReuses += file.cacheReuses;
    for (const fn of file.functions) { summary.functions++; summary[({ error: 'errors', diagnostic: 'diagnostics' })[fn.status] || fn.status]++; } }
  return summary;
}
export function printReactCompilerReport(report, { details = false, log = console.log } = {}) {
  if (!report.enabled) { log('React Compiler: disabled. Enable reactCompiler in the application configuration.'); return; }
  const summary = report.summary;
  log(`React Compiler ${report.compilerVersion}: ${summary.optimized} optimized, ${summary.skipped} skipped, ${summary.errors} errors, ${summary.diagnostics} diagnostics, ${summary.mixed} mixed.`);
  log(`Observed transforms only: ${summary.files} files; ${summary.cacheReuses}/${summary.transforms} transforms reused cached compiler results.${report.truncated ? ' Report truncated at its safety limit.' : ''}`);
  if (report.graphs.some(graph => graph.unobservedInputs || !graph.metadataAvailable)) log('Some graph inputs were not observed by React Compiler; totals do not describe every application component.');
  if (details) for (const file of report.files) {
    log(file.file);
    for (const fn of file.functions) log(`  ${fn.name || '(anonymous)'}${fn.start ? ':' + fn.start.line : ''}: ${fn.status}${fn.events.some(event => event.reason) ? ' — ' + [...new Set(fn.events.map(event => event.reason).filter(Boolean))].join('; ') : ''}`);
    for (const note of file.notes) log('  ' + note);
  }
}
