import { svg } from './dev-ui-icons.mjs';
import { devErrorOverlayStyle } from './dev-error-overlay-style.mjs';

const hydrationMessage = /\bHydration failed because\b|\bA tree hydrated but some attributes\b|\bText content does not match server-rendered HTML\b/i;
const buildSourcePrefix = /^(?:(?:[A-Za-z]:[\\/]|\/)[^:\r\n]*|[^\s:\r\n]+)\.(?:[cm]?[jt]sx?|css|scss|sass|less|json|html?|vue|svelte|astro)(?:\(\d+(?:,\d+)?\)|:\d+(?::\d+)?)?:\s*/i;

function stripBuildSourcePrefixes(line) {
  // Compiler errors can nest an entry filename around an original source path.
  // Remove only recognizable source prefixes, never arbitrary colon-separated text.
  for (let count = 0; count < 16; count++) {
    const next = line.replace(buildSourcePrefix, '');
    if (next === line) break;
    line = next;
  }
  return line;
}

// Only the summary is shortened. The original message and stack stay in the dialog.
export function summarizeDevError(report, { recoverable = false, kind = 'runtime' } = {}) {
  const message = typeof report === 'string' ? report : String(report?.message ?? '');
  const normalizedKind = String(kind).toLowerCase();
  const hydration = hydrationMessage.test(message);
  const title = hydration ? 'Hydration mismatch' : ['typescript', 'type', 'typecheck'].includes(normalizedKind) ? 'TypeScript'
    : normalizedKind === 'build' ? 'Build error' : recoverable || normalizedKind === 'recoverable' ? 'Recovered error' : 'Runtime error';
  let firstLine = message.split(/\r?\n/).find(line => line.trim())?.replace(/^(?:Uncaught\s+)?(?:[\w.]*Error):\s*/, '').trim() || '';
  if (normalizedKind === 'build') firstLine = stripBuildSourcePrefixes(firstLine);
  const description = hydration ? 'The server and browser rendered different output.' : firstLine
    || (title === 'Build error' ? 'Compilation could not finish.' : title === 'TypeScript' ? 'TypeScript reported a problem in your project.' : 'An error occurred while running this page.');
  return { title, description: description.length > 240 ? description.slice(0, 237).trimEnd() + '…' : description, hydration };
}

export function createDevErrorOverlay({ onDismiss = () => {}, onSendToAI = () => {}, onSelectIssue = () => {}, onCopyForAI = () => {} } = {}) {
  const document = globalThis.document;
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const host = node('div'); host.id = '__prnext_dev_error__';
  const shadow = host.attachShadow({ mode: 'open' }), style = node('style'); style.textContent = devErrorOverlayStyle;
  const dialog = node('dialog'); dialog.setAttribute('role', 'alertdialog'); dialog.setAttribute('aria-label', 'PRNext development error');
  const icon = paths => { const result = node('span', 'icon'); result.innerHTML = svg(paths); return result; };
  const header = node('header', 'error-header'), brand = node('div', 'error-brand');
  const count = node('span', 'error-count'); count.setAttribute('aria-live', 'polite'); count.setAttribute('aria-atomic', 'true');
  brand.append(node('strong', '', 'PRNext'), node('span', 'error-brand-label', 'Errors'), count);
  const actions = node('div', 'error-header-actions');
  const copy = node('button', 'error-copy'), copyIcon = icon(''), copyLabel = node('span', '', 'Copy for AI'); copy.type = 'button'; copy.id = 'copy-for-ai'; copy.append(copyIcon, copyLabel);
  const ai = node('button', 'error-ai'); ai.type = 'button'; ai.append(icon('<path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z"/>'), node('span', '', 'Send to AI'));
  const dismiss = node('button', 'error-dismiss'); dismiss.type = 'button'; dismiss.autofocus = true; dismiss.setAttribute('aria-label', 'Dismiss'); dismiss.title = 'Dismiss (Esc)'; dismiss.append(icon('<path d="m6 6 12 12M6 18 18 6"/>'));
  const copyStatus = node('span', 'sr-only'); copyStatus.id = 'error-copy-status'; copyStatus.setAttribute('role', 'status'); copyStatus.setAttribute('aria-atomic', 'true');
  actions.append(copy, ai, dismiss); header.append(brand, actions, copyStatus);
  const issueRegion = node('section', 'error-issue-region');
  const issueList = node('div', 'error-list'); issueList.setAttribute('role', 'group'); issueList.setAttribute('aria-label', 'Errors');
  const omittedNote = node('p', 'error-list-note'); omittedNote.hidden = true; issueRegion.append(issueList, omittedNote);
  const body = node('div', 'error-body'), intro = node('div', 'error-intro'), heading = node('h1'), title = node('button', 'error-title-toggle'), summary = node('p', 'error-summary');
  body.id = 'error-details'; body.hidden = true; body.setAttribute('role', 'region'); body.setAttribute('aria-labelledby', 'error-title');
  title.type = 'button'; title.id = 'error-title'; title.setAttribute('aria-controls', body.id); title.setAttribute('aria-expanded', 'false');
  summary.id = 'error-summary'; heading.append(title); intro.append(heading, summary);
  const editorActions = node('div', 'error-editor-actions'), editor = node('a'); editor.id = 'editor'; editor.hidden = true; editorActions.hidden = true;
  editor.append(icon('<path d="M14 3h7v7m0-7L10 14"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>'), node('span', '', 'Open in editor'));
  editorActions.append(editor);
  const source = node('section', 'source'); source.id = 'source'; source.hidden = true; source.setAttribute('aria-label', 'Source');
  const sourceHead = node('div', 'source-head'), location = node('code', 'location'); location.id = 'source-location';
  sourceHead.append(icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6"/>'), location);
  const sourceFrame = node('pre'); sourceFrame.id = 'source-frame'; sourceFrame.tabIndex = 0; sourceFrame.setAttribute('aria-label', 'Source code');
  source.append(sourceHead, sourceFrame);
  const disclosures = node('div', 'error-disclosures');
  const messageDisclosure = node('details', 'error-disclosure'); messageDisclosure.id = 'message-disclosure';
  const fullMessage = node('pre', 'error-full'); fullMessage.id = 'message'; fullMessage.tabIndex = 0; fullMessage.setAttribute('aria-label', 'Full error message');
  messageDisclosure.append(node('summary', '', 'Full message'), fullMessage);
  const stackDisclosure = node('details', 'error-disclosure'); stackDisclosure.id = 'stack-disclosure';
  const stack = node('pre', 'error-full error-stack'); stack.id = 'details'; stack.tabIndex = 0; stack.setAttribute('aria-label', 'Error stack trace');
  stackDisclosure.append(node('summary', '', 'Stack trace'), stack); disclosures.append(messageDisclosure, stackDisclosure);
  const sourceStatus = node('p', 'error-source-status'); sourceStatus.id = 'source-feedback'; sourceStatus.setAttribute('role', 'status');
  body.append(intro, source, editorActions, disclosures, sourceStatus); dialog.append(header, issueRegion, body); shadow.append(style, dialog);
  const rows = new Map();
  let disposed = false, lastReport, selectedId, dismissing = false, expanded = false;
  function setExpanded(value) {
    expanded = Boolean(value);
    const restoreFocus = !expanded && body.contains(shadow.activeElement);
    body.hidden = !expanded; title.setAttribute('aria-expanded', String(expanded));
    for (const [id, row] of rows) row.button.setAttribute('aria-expanded', String(expanded && id === selectedId));
    if (expanded) dialog.setAttribute('aria-describedby', summary.id); else dialog.removeAttribute('aria-describedby');
    if (restoreFocus) rows.get(selectedId)?.button.focus({ preventScroll: true });
  }
  title.onclick = () => { if (!disposed) setExpanded(!expanded); };
  function requestDismiss() {
    if (disposed || dismissing) return;
    dismissing = true; if (dialog.open) dialog.close(); onDismiss();
  }
  dismiss.onclick = requestDismiss;
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestDismiss(); });
  ai.onclick = () => { if (!disposed) onSendToAI(); };
  copy.onclick = () => { if (!disposed) onCopyForAI(); };
  function setCopyStatus(value = 'idle') {
    if (disposed) return;
    const status = value === 'copied' || value === 'error' ? value : 'idle';
    copy.dataset.status = status;
    copyLabel.textContent = status === 'copied' ? 'Copied' : status === 'error' ? 'Copy failed' : 'Copy for AI';
    copy.setAttribute('aria-label', status === 'idle' ? 'Copy for AI' : `Copy for AI. ${copyLabel.textContent}.`);
    copyIcon.innerHTML = svg(status === 'copied' ? '<path d="m5 12 4 4L19 6"/>' : status === 'error' ? '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3h.01"/>' : '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>');
    copyStatus.textContent = status === 'copied' ? 'Copied for AI.' : status === 'error' ? 'Could not copy for AI.' : '';
  }
  function syncIssues(report, options) {
    const issues = Array.isArray(options.issues) && options.issues.length ? options.issues : [{ id: 'current', report, kind: options.kind, recoverable: options.recoverable }];
    const nextSelected = issues.find(issue => issue.id === options.selectedId)?.id ?? issues.find(issue => issue.report === report)?.id ?? issues[0].id;
    const live = new Set(issues.map(issue => issue.id));
    for (const [id, row] of rows) if (!live.has(id)) { row.button.remove(); rows.delete(id); }
    issues.forEach((issue, index) => {
      let row = rows.get(issue.id);
      if (!row) {
        const button = node('button', 'error-row'); button.type = 'button'; button.dataset.issueId = String(issue.id);
        const type = node('span', 'error-row-type'), dot = node('span', 'error-row-dot'), label = node('span'); dot.setAttribute('aria-hidden', 'true'); type.append(dot, label);
        const message = node('span', 'error-row-message'), file = node('code', 'error-row-file'); file.hidden = true;
        const chevron = node('span', 'error-row-chevron'); chevron.setAttribute('aria-hidden', 'true');
        button.setAttribute('aria-controls', body.id);
        button.append(type, message, file, chevron); button.onclick = () => {
          if (disposed) return;
          const next = selectedId !== issue.id || !expanded;
          onSelectIssue(issue.id); setExpanded(next);
        };
        row = { button, label, message, file }; rows.set(issue.id, row);
      }
      const next = summarizeDevError(issue.report, issue);
      const message = typeof issue.report === 'string' ? issue.report : String(issue.report?.message ?? ''), stack = String(issue.report?.stack ?? '');
      if (row.reportMessage !== message || row.reportStack !== stack || row.kind !== issue.kind) { row.file.textContent = ''; row.file.hidden = true; }
      row.reportMessage = message; row.reportStack = stack; row.kind = issue.kind; row.label.textContent = next.title; row.message.textContent = next.description; row.message.title = next.description;
      row.message.hidden = next.hydration;
      row.button.dataset.kind = next.hydration ? 'hydration' : issue.kind || 'runtime'; row.button.dataset.recoverable = String(issue.recoverable === true); row.button.setAttribute('aria-pressed', String(issue.id === nextSelected));
      row.button.setAttribute('aria-expanded', String(expanded && issue.id === nextSelected));
      if (issueList.children[index] !== row.button) issueList.insertBefore(row.button, issueList.children[index] || null);
    });
    const omitted = Number.isFinite(options.omitted) ? Math.max(0, Math.trunc(options.omitted)) : 0, total = issues.length + omitted;
    count.textContent = String(total); count.setAttribute('aria-label', `${total} ${total === 1 ? 'error' : 'errors'}`);
    omittedNote.hidden = omitted === 0; omittedNote.textContent = omitted ? `${issues.length} shown · ${omitted} more` : '';
    return nextSelected;
  }
  function setSourceStatus(text) { if (!disposed) sourceStatus.textContent = text || ''; }
  function setSource(value) {
    if (disposed) return;
    const file = typeof value?.file === 'string' ? value.file : '';
    const line = Number.isFinite(value?.line) ? value.line : undefined, column = Number.isFinite(value?.column) ? value.column : undefined;
    location.textContent = file + (line ? ':' + line : '') + (column ? ':' + column : '');
    location.title = location.textContent;
    const frame = typeof value?.frame === 'string' ? value.frame : Array.isArray(value?.excerpt) ? value.excerpt.map(entry => `${entry.line === line ? '>' : ' '} ${entry.line} | ${entry.text}`).join('\n') : '';
    sourceFrame.textContent = frame; sourceFrame.hidden = !frame; sourceHead.hidden = !file; source.hidden = !file && !frame;
    editor.hidden = !/^(?:vscode|cursor):\/\/file\//.test(value?.editorUrl || '');
    if (editor.hidden) editor.removeAttribute('href'); else editor.href = value.editorUrl;
    editorActions.hidden = editor.hidden;
    const row = rows.get(selectedId); if (row) { row.file.textContent = location.textContent; row.file.title = location.textContent; row.file.hidden = !file; }
  }
  return {
    host,
    render(report, options = {}) {
      if (disposed) return;
      const nextSelected = syncIssues(report, options), next = summarizeDevError(report, options), changed = report !== lastReport || nextSelected !== selectedId;
      selectedId = nextSelected;
      title.textContent = next.title; summary.textContent = next.description;
      fullMessage.textContent = typeof report === 'string' ? report : String(report?.message ?? '');
      stack.textContent = String(report?.stack ?? ''); stackDisclosure.hidden = !stack.textContent;
      dialog.dataset.kind = next.hydration ? 'hydration' : options.kind || 'runtime'; dialog.dataset.recoverable = String(options.recoverable === true);
      if (changed) { setExpanded(false); messageDisclosure.open = false; stackDisclosure.open = false; setSource(undefined); setSourceStatus(''); setCopyStatus('idle'); body.scrollTop = 0; }
      lastReport = report; dismissing = false;
      if (!host.isConnected) document.documentElement.append(host);
      if (!dialog.open) { dialog.showModal(); dismiss.focus({ preventScroll: true }); }
    },
    setSource, setSourceStatus, setCopyStatus,
    focusDismiss() { if (!disposed && dialog.open) dismiss.focus({ preventScroll: true }); },
    dispose() { if (disposed) return; disposed = true; rows.clear(); if (dialog.open) dialog.close(); host.remove(); },
  };
}
