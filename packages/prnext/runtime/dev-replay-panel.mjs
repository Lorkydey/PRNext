import { getDevReplayRecorder } from './dev-replay-client.mjs';
import { validateReplay } from './dev-replay-model.mjs';

const names = { visit: 'Visit', click: 'Click', fill: 'Fill parameter', expectVisible: 'Visible on screen', expectText: 'Expect text', expectURL: 'Expect URL' };
const stateNames = { running: 'Running', verified: 'Verified', failed: 'Failed', inconclusive: 'Inconclusive', cancelled: 'Cancelled', passed: 'Passed', pending: 'Pending' };
const targetLabel = target => target?.kind === 'role' ? `${target.role} “${target.name}”` : `${target?.kind || 'element'} “${target?.value || ''}”`;

// This view keeps its input nodes across snapshot and result updates. Test
// parameters never enter the saved definition, browser storage or AI context.
export function createDevReplayPanel({ shadow, tools, closeForRecording }) {
  const document = shadow.ownerDocument, view = document.defaultView, recorder = getDevReplayRecorder(view);
  const node = (tag, className, text) => { const result = document.createElement(tag); if (className) result.className = className; if (text !== undefined) result.textContent = text; return result; };
  const button = (text, task, className) => { const result = node('button', className, text); result.type = 'button'; result.onclick = () => act(result, task); return result; };
  const section = title => { const result = node('section', 'wb-replay-section'); result.append(node('h3', '', title)); return result; };
  const root = node('div', 'wb-replay');
  const heading = node('div', 'wb-replay-head'), intro = node('div'); intro.append(node('h3', '', 'Record a flow. Verify it again.'), node('p', '', 'Record actions, add expectations, then replay the same flow against your current build.'));
  const start = button('Start recording', () => { if (!recorder) throw Error('Restart PRNext dev to enable recording.'); recorder.start(); closeForRecording(); }, 'wb-replay-primary'); heading.append(intro, start);
  const privacy = node('p', 'wb-replay-note', 'Input values are omitted. Sensitive fields are excluded. Supply temporary test values when you run a replay.');
  const feedback = node('div', 'wb-replay-feedback'); feedback.setAttribute('role', 'status');
  const draftSection = section('Recording draft'), draftHead = node('div', 'wb-replay-section-head'), draftTitle = draftSection.firstChild, draftStatus = node('span', 'wb-replay-badge'); draftHead.append(draftTitle, draftStatus); draftSection.append(draftHead);
  const nameLabel = node('label', 'wb-replay-field', 'Scenario name'), nameInput = node('input'), nameError = node('span', 'wb-replay-feedback'); nameInput.type = 'text'; nameInput.maxLength = 120; nameInput.autocomplete = 'off'; nameInput.name = 'replay-scenario-name'; nameError.id = 'prnext-replay-name-error'; nameError.hidden = true; nameInput.setAttribute('aria-describedby', nameError.id); nameLabel.append(nameInput, nameError);
  nameInput.addEventListener('input', () => { nameInput.removeAttribute('aria-invalid'); nameError.hidden = true; recorder?.setName(nameInput.value); });
  const draftSteps = node('ol', 'wb-replay-steps'), draftActions = node('div', 'wb-replay-actions');
  const save = button('Save scenario', async () => {
    if(!nameInput.value.trim()){nameError.textContent='Name this scenario before saving.';nameError.hidden=false;nameInput.setAttribute('aria-invalid','true');nameInput.focus();throw Error(nameError.textContent);}
    const scenario = validateReplay(recorder?.getState().scenario); const result = await tools.call('dev_replay_save', { scenario });
    selected = result.scenario.id; recorder.discard(); await refresh(); tell('Scenario saved. Run it to check the current build.');
  }, 'wb-replay-primary');
  const resume = button('Resume recording', () => { recorder.resume(); closeForRecording(); });
  const stop = button('Stop recording', () => recorder.stop());
  const visible = button('Add on-screen assertion', () => { recorder.pickAssertion('expectVisible'); closeForRecording(); });
  const text = button('Add text assertion', () => { recorder.pickAssertion('expectText'); closeForRecording(); });
  const url = button('Add URL assertion', () => recorder.addURLAssertion());
  const discard = button('Discard draft', () => { recorder.discard(); tell('Draft discarded.'); });
  draftActions.append(save, resume, stop, visible, text, url, discard); draftSection.append(nameLabel, draftSteps, draftActions, node('p', 'wb-replay-note', 'Add at least one assertion before saving. “Visible on screen” requires the whole element to be on screen without scrolling. Every target must match one element exactly.'));
  const library = section('Saved scenarios'), list = node('div', 'wb-replay-list'); library.append(list);
  const selectedSection = section('Scenario'), selectedHeading = selectedSection.firstChild, selectedSteps = node('ol', 'wb-replay-steps');
  const parameters = node('div', 'wb-replay-params');
  const parameterHint = node('p', 'wb-replay-note', 'Test values are sent only for this run and cleared when the panel closes.');
  const selectedActions = node('div', 'wb-replay-actions');
  const runButton = button('Run replay', async () => {
    const scenario = chosen(); if (!scenario) return;
    const values = Object.fromEntries([...parameterInputs].map(([name, input]) => [name, input.value]));
    const result = await tools.call('dev_replay_run', { id: scenario.id, parameters: values });
    for (const input of parameterInputs.values()) input.value = '';
    run = { ...result, steps: [] }; scenario.latest = { runId: result.runId, state: 'running' }; previous = undefined; scenarioChanged = comparisonChanged = remoteChanged = false; pollingCount = 0; paintRun(); schedulePoll();
  }, 'wb-replay-primary');
  const exportButton = button('Export Playwright test', async () => {
    const result = await tools.call('dev_replay_export', { id: selected }); exportedCode.textContent = result.code; exported.open = true; exported.hidden = false; exportedSummary.textContent = result.filename || 'Playwright test'; tell('Playwright test ready. Copy the code below.');
  });
  const send = button('Send scenario to AI', async () => {
    const scenario = chosen(); const briefRun = run ? { runId: run.runId, state: run.state, reason: run.reason, steps: run.steps, errors: run.errors?.slice(0, 5), before: run.before, after: run.after } : undefined;
    await tools.sendContext({ kind: 'replay', scenario: { version: scenario.version, id: scenario.id, name: scenario.name, viewport: scenario.viewport, steps: scenario.steps }, ...(briefRun ? { run: briefRun } : {}) }, prompt.value);
    tell('Scenario context is available through PRNext MCP. Ask your assistant to review it.');
  });
  const deleteButton = button('Delete scenario', async () => { await tools.call('dev_replay_delete', { id: selected }); selected = undefined; run = undefined; previous = undefined; await refresh(); tell('Scenario deleted.'); });
  selectedActions.append(runButton, exportButton, send, deleteButton);
  const aiLabel = node('label', 'wb-replay-field', 'Instruction for your assistant (optional)'), prompt = node('textarea'); prompt.rows = 2; prompt.maxLength = 2000; prompt.placeholder = 'Review this flow and its latest result…'; aiLabel.append(prompt);
  const aiHint = node('p', 'wb-replay-note', 'Connect your assistant in AI connection to send this scenario.');
  const result = node('section', 'wb-replay-result'); result.setAttribute('aria-label', 'Replay result');
  const resultTitle = node('h4'), resultReason = node('p'), definitionNotice = node('p', 'wb-replay-feedback'), generation = node('div', 'wb-replay-generation'), errors = node('pre'), images = node('div', 'wb-replay-images'), previousLine = node('p', 'wb-replay-note'); result.append(resultTitle, resultReason, definitionNotice, generation, errors, images, previousLine);
  const setup = node('div'); setup.hidden = true; setup.append(node('p', '', 'Install Playwright in this project, then run the scenario again.'), node('pre', '', 'npm i -D @playwright/test\nnpx playwright install chromium')); result.append(setup);
  const exported = node('details', 'wb-replay-export'), exportedSummary = node('summary', '', 'Playwright test'), exportedCode = node('pre'); exported.hidden = true; exported.append(exportedSummary, exportedCode);
  const copy = button('Copy test', async () => { if (!view.navigator.clipboard?.writeText) throw Error('Select and copy the code below. Clipboard access is unavailable.'); await view.navigator.clipboard.writeText(exportedCode.textContent); tell('Playwright test copied.'); }); exported.append(copy);
  selectedSection.append(selectedSteps, parameters, parameterHint, selectedActions, aiLabel, aiHint, result, exported);
  root.append(heading, privacy, feedback, draftSection, library, selectedSection);
  let disposed = false, active = false, busy = false, loading = false, selected, scenarios = [], run, previous, scenarioChanged = false, comparisonChanged = false, remoteChanged = false, timer, pollingCount = 0, listSignature, draftSignature, selectedSignature, resultSignature, loadEpoch = 0;
  const parameterInputs = new Map();
  const chosen = () => scenarios.find(scenario => scenario.id === selected);
  const tell = text => { if (!disposed) feedback.textContent = text || ''; };
  async function act(control, task) {
    if (busy || disposed) return; busy = true; control.disabled = true; control.setAttribute('aria-busy', 'true'); tell('');
    try { await task(); } catch (error) { tell(error.message || 'Unable to complete this action. Try again.'); }
    finally { busy = false; control.removeAttribute('aria-busy'); if (!disposed) { control.disabled = false; sync(tools.snapshot()); } }
  }
  function makeSteps(parent, steps, editable, outcomes = []) {
    parent.replaceChildren();
    for (const [index, step] of steps.entries()) {
      const row = node('li', 'wb-replay-step'), body = node('div', 'wb-replay-step-body'); row.dataset.step = String(index);
      body.append(node('strong', '', names[step.type] || step.type), node('code', '', step.path || (step.type === 'fill' ? step.parameter + ' → ' : '') + targetLabel(step.target)));
      if (step.type === 'expectText') body.append(node('code', '', 'Expected: “' + step.text + '”'));
      const outcome = outcomes.find(item => item.index === index);
      if (outcome) { const detail = node('span', '', (stateNames[outcome.state] || outcome.state) + (outcome.reason ? ': ' + outcome.reason : '')); detail.dataset.stepState = outcome.state; body.append(detail); if (outcome.expected !== undefined) body.append(node('code', '', 'Expected: ' + String(outcome.expected))); if (outcome.observed !== undefined) body.append(node('code', '', 'Observed: ' + String(outcome.observed))); }
      row.append(body);
      if (editable && index > 0) { const remove = button('Remove', () => recorder.removeStep(index), 'wb-replay-remove'); remove.setAttribute('aria-label', 'Remove step ' + (index + 1)); row.append(remove); }
      parent.append(row);
    }
  }
  function paintDraft() {
    const value = recorder?.getState(); draftSection.hidden = !value?.scenario;
    if (!value?.scenario) return;
    draftStatus.textContent = value.mode === 'recording' ? 'Recording' : value.mode === 'paused' ? 'Paused' : 'Ready to save';
    if (nameInput.value !== value.scenario.name) nameInput.value = value.scenario.name;
    resume.hidden = value.mode === 'recording'; stop.hidden = value.mode === 'stopped';
    const signature = JSON.stringify(value.scenario.steps);
    if (signature !== draftSignature) { draftSignature = signature; makeSteps(draftSteps, value.scenario.steps, true); }
    if (value.message) tell(value.message);
  }
  function paintLibrary() {
    const signature = JSON.stringify(scenarios.map(item => [item.id, item.name]));
    if (signature !== listSignature) {
      listSignature = signature; list.replaceChildren();
      if (!scenarios.length) list.append(node('p', '', 'No scenarios yet. Start recording to save a repeatable flow.'));
      for (const scenario of scenarios) {
        const control = button('', async () => { if (selected === scenario.id) return; selected = scenario.id; run = undefined; previous = undefined; clearPoll(); paintSelection(); await readResult(); }); control.dataset.scenarioId = scenario.id;
        control.append(node('span', 'wb-replay-list-name', scenario.name), node('span', 'wb-replay-list-state', scenario.latest ? stateNames[scenario.latest.state] || scenario.latest.state : 'Not run')); list.append(control);
      }
    }
    for (const control of list.querySelectorAll('button')) {
      control.setAttribute('aria-pressed', String(control.dataset.scenarioId === selected));
      const item = scenarios.find(scenario=>scenario.id===control.dataset.scenarioId);control.querySelector('.wb-replay-list-state').textContent=item?.latest?stateNames[item.latest.state]||item.latest.state:'Not run';
    }
  }
  function paintSelection() {
    const scenario = chosen(); selectedSection.hidden = !scenario; paintLibrary();
    if (!scenario) return;
    selectedHeading.textContent = scenario.name;
    const signature = JSON.stringify([scenario.id, scenario.steps]);
    if (signature !== selectedSignature) {
      selectedSignature = signature; parameters.replaceChildren(); parameterInputs.clear(); prompt.value = ''; exported.hidden = true; resultSignature = undefined;
      for (const name of new Set(scenario.steps.filter(step => step.type === 'fill').map(step => step.parameter))) {
        const step = scenario.steps.find(step => step.parameter === name), label = node('label', 'wb-replay-field', name + ' · ' + targetLabel(step.target)), input = node('input'); input.type = 'password'; input.name = 'replay-' + name; input.autocomplete = 'off'; input.setAttribute('aria-label', 'Test value for ' + name); label.append(input); parameters.append(label); parameterInputs.set(name, input);
      }
      parameterHint.hidden = !parameterInputs.size;
    }
    paintRun();
  }
  function paintRun() {
    const scenario = chosen(); if (!scenario) return;
    makeSteps(selectedSteps, scenario.steps, false, run?.steps || []);
    result.hidden = !run; if (!run) return;
    const signature = JSON.stringify(run) + JSON.stringify(previous && [previous.runId, previous.state]) + [scenarioChanged, comparisonChanged, remoteChanged].join(); if (signature === resultSignature) return; resultSignature = signature;
    result.dataset.state = run.state; resultTitle.textContent = scenarioChanged ? 'Earlier scenario result · ' + (stateNames[run.state] || run.state) : stateNames[run.state] || 'Result'; resultReason.textContent = run.reason || (run.state === 'running' ? 'The isolated browser is checking this scenario.' : run.state === 'verified' ? 'All recorded assertions passed on the recorded build.' : 'Review the step result before continuing.');
    definitionNotice.textContent = remoteChanged ? 'The saved scenario changed. Refresh to review its current steps before running it.' : scenarioChanged ? 'This result belongs to an earlier scenario definition. Run the current scenario to verify it.' : comparisonChanged ? 'The previous run used different scenario steps. These results do not verify the same flow.' : ''; definitionNotice.hidden = !definitionNotice.textContent;
    generation.replaceChildren();
    for (const [label, value] of [['Before', run.before], ['After', run.after]]) if (value) generation.append(node('span', '', label + ': build ' + String(value.buildId ?? 'unknown') + ' · generation ' + String(value.sequence ?? 'unknown')));
    errors.textContent = (run.errors || []).slice(0, 10).join('\n'); errors.hidden = !errors.textContent;
    images.replaceChildren();
    for (const key of ['before', 'after']) {
      const screenshot = run.screenshots?.[key]; if (screenshot?.mimeType !== 'image/png' || typeof screenshot.data !== 'string' || screenshot.data.length > 180000 || !/^[A-Za-z0-9+/=]+$/.test(screenshot.data)) continue;
      const figure = node('figure'), image = node('img'); image.alt = key === 'before' ? 'Application before replay' : 'Application after replay'; image.src = 'data:image/png;base64,' + screenshot.data; figure.append(node('figcaption', '', key === 'before' ? 'Before replay' : 'After replay'), image); images.append(figure);
    }
    images.hidden = !images.children.length; previousLine.textContent = previous ? 'Previous run: ' + (stateNames[previous.state] || previous.state) + ' · build ' + String(previous.after?.buildId ?? previous.before?.buildId ?? 'unknown') + ' · generation ' + String(previous.after?.sequence ?? previous.before?.sequence ?? 'unknown') + (previous.finishedAt ? ' · ' + new Date(previous.finishedAt).toLocaleString() : '') : ''; previousLine.hidden = !previous;
    setup.hidden = !/playwright|browser.*(?:install|missing|unavailable)|chromium.*(?:install|missing)/i.test([run.reason, ...(run.errors || [])].join(' '));
  }
  function sync(data = tools.snapshot()) {
    if (disposed) return; paintDraft(); paintSelection();
    const connected = data.connection === 'connected' && data.ai?.connected === true;
    send.disabled = busy || !connected || !chosen(); aiHint.hidden = connected; aiLabel.hidden = !connected;
    runButton.disabled = busy || remoteChanged || run?.state === 'running' || !chosen(); exportButton.disabled = deleteButton.disabled = busy || !chosen(); start.disabled = busy || !recorder; save.disabled = busy || !recorder?.getState().scenario;
  }
  function clearPoll() { view.clearTimeout(timer); timer = undefined; }
  function schedulePoll() {
    clearPoll(); if (!active || disposed || run?.state !== 'running') return;
    if (++pollingCount > 120) { tell('Replay is still running. Refresh to check its result.'); return; }
    timer = view.setTimeout(() => { timer = undefined; void readResult().catch(error => tell(error.message)); }, 750);
  }
  async function readResult() {
    if (!selected || disposed || !active) return;
    const id = selected, epoch = loadEpoch, result = await tools.call('dev_replay_result', { id, ...(run?.runId ? { runId: run.runId } : {}) });
    if (disposed || !active || selected !== id || epoch !== loadEpoch) return;
    const previousState = run?.state;
    run = result.run; previous = result.previous; scenarioChanged = result.scenarioChanged === true; comparisonChanged = result.comparisonChanged === true;
    if(run&&run.state!=='running'&&run.state!==previousState)tell('Replay '+(stateNames[run.state]||run.state).toLocaleLowerCase()+'. '+(run.reason||''));
    const current = chosen(); if(current&&run)current.latest={runId:run.runId,state:run.state};if(current && result.scenario)remoteChanged = JSON.stringify([current.name,current.viewport,current.steps]) !== JSON.stringify([result.scenario.name,result.scenario.viewport,result.scenario.steps]);
    paintRun(); sync(); schedulePoll();
  }
  async function refresh() {
    if (loading || disposed || !active) return; loading = true; const epoch = ++loadEpoch;
    try {
      const result = await tools.call('dev_replay_list'); if (disposed || !active || epoch !== loadEpoch) return;
      scenarios = result.scenarios || []; remoteChanged = false; if (!scenarios.some(item => item.id === selected)) { selected = scenarios[0]?.id; run = undefined; previous = undefined; scenarioChanged = comparisonChanged = false; }
      paintSelection(); await readResult(); sync();
    } finally { loading = false; if(active&&!disposed&&epoch!==loadEpoch)void refresh().catch(error=>tell(error.message)); }
  }
  const unsubscribe = recorder?.subscribe(paintDraft);
  sync();
  return {
    node: root, sync, refresh,
    activate() { if (disposed) return; active = true; pollingCount = 0; void refresh().catch(error => tell(error.message)); },
    deactivate() { active = false; loadEpoch++; clearPoll(); for (const input of parameterInputs.values()) input.value = ''; },
    dispose() { disposed = true; active = false; loadEpoch++; clearPoll(); unsubscribe?.(); for (const input of parameterInputs.values()) input.value = ''; root.remove(); },
  };
}
