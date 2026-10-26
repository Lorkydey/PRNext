// Pure diagnostic snapshots and clipboard reports; no browser or connection state.
export const MAX_DEV_ISSUES = 50;
export const MAX_DEV_ISSUE_TEXT = 48 * 1024;
export const MAX_DEV_SOURCE_BYTES = 48 * 1024;
export const MAX_DEV_AI_REPORT_BYTES = 512 * 1024;

const encoder = new TextEncoder();
const read = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
const string = value => { try { return String(value ?? ''); } catch { return '[unavailable diagnostic]'; } };
const provided = value => value !== undefined && value !== null;

function diagnostic(error) {
  const name = read(error, 'name'), message = read(error, 'message'), stack = read(error, 'stack');
  return { name: typeof name === 'string' ? name : 'Error', message: string(message || error), stack: string(stack || message || error) };
}
function boundedReport(value) {
  return { name: value.name.slice(0, 256), message: value.message.slice(0, MAX_DEV_ISSUE_TEXT), stack: value.stack.slice(0, MAX_DEV_ISSUE_TEXT) };
}
const report = error => boundedReport(diagnostic(error));
function hash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(36);
}

/** Current issues only. Preserve the original error identity separately from its bounded snapshot. */
export function collectDevIssues({ critical, criticalKind = 'runtime', typeErrors = [], recoverable } = {}) {
  const types = [], unique = new Set(), groups = new Map();
  for (const error of Array.isArray(typeErrors) ? typeErrors : []) {
    const value = diagnostic(error), key = JSON.stringify([value.name, value.message, value.stack]);
    if (unique.has(key)) continue;
    unique.add(key);
    const base = 'ts-' + hash(key), item = { key, base, error, report: boundedReport(value) };
    types.push(item);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(item);
  }
  // Rare short-hash collisions get deterministic suffixes independent of display order.
  for (const group of groups.values()) {
    group.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    for (let index = 0; index < group.length; index++) group[index].id = group[index].base + (index ? '-' + (index + 1) : '');
  }
  const issues = [], hasCritical = provided(critical), hasRecoverable = provided(recoverable);
  if (hasCritical) issues.push({ id: 'critical', error: critical, report: report(critical), kind: string(criticalKind || 'runtime').slice(0, 64), recoverable: false });
  const available = MAX_DEV_ISSUES - Number(hasCritical) - Number(hasRecoverable);
  for (const item of types.slice(0, available)) issues.push({ id: item.id, error: item.error, report: item.report, kind: 'typescript', recoverable: false });
  if (hasRecoverable) issues.push({ id: 'recoverable', error: recoverable, report: report(recoverable), kind: 'recoverable', recoverable: true });
  return { issues, omitted: Math.max(0, types.length - available) };
}

function pathname(value) {
  try { return new URL(string(value || '/'), 'http://prnext.local').pathname.slice(0, 2048) || '/'; } catch { return '/'; }
}
const bytes = value => encoder.encode(value).length;
function clipBytes(value, limit) {
  if (limit <= 0) return '';
  if (bytes(value) <= limit) return value;
  let low = 0, high = Math.min(value.length, limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(value.slice(0, middle)) <= limit) low = middle; else high = middle - 1;
  }
  // Never split a UTF-16 pair at the byte boundary.
  if (low && /[\uD800-\uDBFF]/.test(value[low - 1]) && /[\uDC00-\uDFFF]/.test(value[low] || '')) low--;
  return value.slice(0, low);
}
function stackWithoutMessage({ name, message, stack }) {
  for (const prefix of [name + ': ' + message, message]) {
    if (stack === prefix || prefix.startsWith(stack)) return '';
    for (const newline of ['\r\n', '\n']) if (stack.startsWith(prefix + newline)) return stack.slice(prefix.length + newline.length);
  }
  return stack;
}
function sourceFor(sourceById, id) {
  try {
    if (sourceById instanceof Map) return sourceById.get(id);
    return sourceById && Object.hasOwn(sourceById, id) ? sourceById[id] : undefined;
  } catch { return undefined; }
}
function sourceText(source) {
  if (!source || typeof source !== 'object') return '';
  const file = read(source, 'file'), frame = read(source, 'frame');
  if (typeof file !== 'string' && typeof frame !== 'string') return '';
  const line = read(source, 'line'), column = read(source, 'column');
  let location = typeof file === 'string' ? file.slice(0, 2048) : '';
  if (location && Number.isSafeInteger(line) && line > 0) {
    location += ':' + line;
    if (Number.isSafeInteger(column) && column > 0) location += ':' + column;
  }
  const original = [location ? 'Source: ' + location : '', typeof frame === 'string' ? frame : ''].filter(Boolean).join('\n');
  if (bytes(original) <= MAX_DEV_SOURCE_BYTES) return original;
  const note = '\n[Source frame truncated at 48 KiB.]';
  return clipBytes(original, MAX_DEV_SOURCE_BYTES - bytes(note)) + note;
}

/** This preserves recorded diagnostic text; it does not claim to sanitize user-logged secrets. */
export function formatDevIssuesForAI(issues, { route = '/', sourceById, omitted = 0 } = {}) {
  const values = Array.isArray(issues) ? issues : [], selected = values.slice(0, MAX_DEV_ISSUES);
  const knownOmitted = Number.isSafeInteger(omitted) && omitted > 0 ? omitted : 0;
  let omittedCount = knownOmitted + Math.max(0, values.length - selected.length), truncated = false, limitedFields = false;
  let output = 'Fix all errors below.\n\nRoute: ' + pathname(route);
  // Reserve enough UTF-8 bytes for explicit omission/truncation notices.
  const budget = MAX_DEV_AI_REPORT_BYTES - 512;
  for (let index = 0; index < selected.length; index++) {
    const issue = selected[index] || {}, detail = report(read(issue, 'report') || read(issue, 'error'));
    const stack = stackWithoutMessage(detail), source = sourceText(sourceFor(sourceById, read(issue, 'id')));
    limitedFields ||= detail.message.length === MAX_DEV_ISSUE_TEXT || detail.stack.length === MAX_DEV_ISSUE_TEXT;
    const block = '\n\n' + (index + 1) + '. ' + string(read(issue, 'kind') || 'runtime').slice(0, 64) + ' — ' + detail.name
      + '\n' + detail.message + (stack ? '\n\nStack:\n' + stack : '') + (source ? '\n\n' + source : '');
    const remaining = budget - bytes(output);
    if (bytes(block) > remaining) {
      output += clipBytes(block, remaining);truncated = true;omittedCount += selected.length - index - 1;break;
    }
    output += block;
  }
  if (!selected.length) output += '\n\nNo current errors.';
  if (limitedFields) output += '\n\n[Diagnostic message and stack fields are limited to 48 KiB each.]';
  if (truncated) output += '\n\n[Report truncated at 512 KiB.]';
  if (omittedCount) output += '\n\n[' + omittedCount + ' additional current issue' + (omittedCount === 1 ? '' : 's') + ' omitted.]';
  return output;
}
