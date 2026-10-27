import { createElementPicker } from './dev-element-picker.mjs';
import { durationLabel, materializeRoute, routeParameters, formatMcpConfig } from './dev-tools-model.mjs';
import { svg } from './dev-ui-icons.mjs';
import { workbenchStyle } from './dev-workbench-style.mjs';
import { devAiStyle } from './dev-ai-style.mjs';
import { devAiBrands, devMcpBrand } from './dev-ai-brands.mjs';

const headings = { requests: 'Requests', performance: 'Performance', routes: 'Routes & cache', ai: 'AI connection' };
const mcpGuides = {
  codex: { text: 'Merge this TOML into .codex/config.toml in a trusted project, or ~/.codex/config.toml for all projects. Restart your Codex session after saving.', url: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli' },
  cursor: { text: 'Merge this JSON into .cursor/mcp.json at your project root, then enable the server in Cursor’s MCP settings.', url: 'https://cursor.com/docs/mcp' },
  claude: { text: 'In Claude Desktop, open Settings → Developer → Edit Config. Merge this JSON into claude_desktop_config.json, then fully quit and reopen Claude Desktop.', url: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers' },
  other: { text: 'Add a local stdio MCP server using this command and its arguments. If your client supports mcpServers JSON, merge this entry into its configuration.', url: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers' },
};

export function createDevToolsPanel({ shadow, tools, restoreFocus }) {
  const document = shadow.ownerDocument, view = document.defaultView;
  const node = (tag, className, text) => { const result = document.createElement(tag); if (className) result.className = className; if (text !== undefined) result.textContent = text; return result; };
  const button = (label, onClick, className = '') => { const result = node('button', className, label); result.type = 'button'; result.onclick = onClick; return result; };
  const dialog = node('dialog', 'wb wb-tools'); dialog.setAttribute('aria-label', 'Development inspector');
  const style = node('style'); style.textContent = workbenchStyle + devAiStyle; shadow.append(style);
  const header = node('div', 'wb-head'), title = node('strong', 'wb-title'), status = node('span', 'wb-context');
  const refresh = button('Refresh', () => load(true), 'wb-push');
  const close = button('', () => dialog.close(), 'wb-close'); close.innerHTML = svg('<path d="m6 6 12 12M6 18 18 6"/>'); close.setAttribute('aria-label', 'Close inspector');
  header.append(title, status, refresh, close);
  const nav = node('nav', 'wb-tools-nav'); nav.setAttribute('aria-label', 'Development panels');
  for (const [key, label] of Object.entries(headings)) { const item = button(label, () => open(key)); item.dataset.panel = key; nav.append(item); }
  const filter = node('input', 'wb-tools-search'); filter.type = 'search'; filter.placeholder = 'Filter requests…'; filter.setAttribute('aria-label', 'Filter requests');
  const content = node('div', 'wb-tools-content');
  const feedback = node('div', 'wb-tools-feedback'); feedback.setAttribute('role', 'status');
  dialog.append(header, nav, filter, content, feedback); shadow.append(dialog);
  let active = 'requests', stop, unsubscribe, disposed = false, busy = false, context, picker, disposeAiView, aiViewId=0;
  let selectedRoute, routeValues = {}, connection, refreshing = false, lastSignature, instruction = '', mcpClient = 'codex', syncAiView, pickEpoch = 0;
  const query = () => filter.value.toLocaleLowerCase();
  const assistantConnected = (data=tools.snapshot()) => data.connection==='connected'&&data.ai?.connected===true;
  function setFeedback(message) { feedback.textContent = message || ''; }
  function disclosure(trigger, reveal, inner, details) {
    let expanded=false,timer;
    const finish=()=>{view.clearTimeout(timer);if(details&&!expanded)details.open=false;reveal.style.height=expanded?'auto':'0px';};
    const settle=()=>{view.clearTimeout(timer);timer=view.setTimeout(finish,260);};
    function set(open,{animate=true}={}) {
      open=Boolean(open);if(open===expanded&&(!details||details.open===open))return;
      const height=reveal.getBoundingClientRect().height;
      expanded=open;if(details){details.open=true;details.dataset.expanded=String(open);}
      if(!open&&reveal.contains(shadow.activeElement))trigger.focus({preventScroll:true});
      reveal.inert=!open;reveal.setAttribute('aria-hidden',String(!open));trigger.setAttribute('aria-expanded',String(open));
      const immediate=!animate||view.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if(immediate)reveal.style.transition='none';
      reveal.style.height=height+'px';void reveal.offsetHeight;
      reveal.dataset.expanded=String(open);reveal.style.height=(open?inner.getBoundingClientRect().height:0)+'px';
      if(immediate){finish();void reveal.offsetHeight;reveal.style.removeProperty('transition');}else settle();
    }
    const toggle=event=>{event.preventDefault();set(!expanded);};
    const complete=event=>{if(event.target===reveal&&event.propertyName==='height'&&Math.abs(reveal.getBoundingClientRect().height-(expanded?inner.getBoundingClientRect().height:0))<1)finish();};
    const observer=view.ResizeObserver?new view.ResizeObserver(()=>{if(expanded&&reveal.style.height!=='auto'){reveal.style.height=inner.getBoundingClientRect().height+'px';settle();}}):undefined;
    reveal.style.height='0px';reveal.dataset.expanded='false';reveal.inert=true;reveal.setAttribute('aria-hidden','true');trigger.setAttribute('aria-expanded','false');
    if(details){details.dataset.expanded='false';details.prnextExpand=set;}
    trigger.addEventListener('click',toggle);reveal.addEventListener('transitionend',complete);observer?.observe(inner);
    return {set,dispose(){view.clearTimeout(timer);observer?.disconnect();trigger.removeEventListener('click',toggle);reveal.removeEventListener('transitionend',complete);}};
  }
  async function action(control, task, success) {
    if (busy) return; busy = true; control.disabled = true; control.setAttribute('aria-busy', 'true'); setFeedback('');if(active==='ai')syncAiView?.(tools.snapshot());
    try { const result = await task(); if (success) setFeedback(typeof success === 'function' ? success(result) : success); return result; }
    catch (error) { setFeedback(error.message || 'The action failed.'); }
    finally { busy = false; control.disabled = false; control.removeAttribute('aria-busy');if(active==='ai'&&!disposed)syncAiView?.(tools.snapshot()); }
  }
  async function openEditor(args) {
    const result = await tools.call('dev_open_editor', args);
    if (!/^(?:vscode|cursor):\/\//.test(result.editorUrl || '')) throw Error('The editor link is unavailable.');
    const link = node('a'); link.href = result.editorUrl; link.click(); return result;
  }
  function empty(text) { return node('p', 'wb-empty', text); }
  function meta(text) { return node('span', 'wb-muted', text); }
  function pair(label, value) { const row = node('div', 'wb-tools-pair'); row.append(meta(label), node('span', '', value)); return row; }
  function section(label) { const section = node('section', 'wb-tools-section'); section.append(node('h3', '', label)); return section; }
  function tableHead(labels) { const row = node('div', 'wb-request-grid wb-tools-labels'); for (const label of labels) row.append(meta(label)); return row; }
  function requests(data) {
    const records = [...(data.requests || []).filter(entry => entry.source === 'server' || entry.clientId !== data.clientId).map(entry => ({ ...entry, source: entry.source || 'browser' })), ...(data.localRequests || [])]
      .filter(entry => !query() || [entry.method, entry.path, entry.status, entry.source].join(' ').toLocaleLowerCase().includes(query()))
      .sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 300);
    const body = node('div'); body.append(tableHead(['Request', 'Status', 'Time', 'Source']));
    for (const record of records) {
      const details = node('details', 'wb-request'), summary = node('summary', 'wb-request-grid'); details.dataset.key = 'request:' + record.source + ':' + record.id;
      const path = node('span', 'wb-request-path'); path.append(node('b', '', record.method || 'GET'), document.createTextNode(' ' + (record.path || '/')));
      const statusText = record.status == null ? record.error || 'Failed' : String(record.status);
      summary.append(path, node('span', record.failed || record.status >= 400 ? 'wb-error-text' : '', statusText), meta(durationLabel(record.duration)), meta(record.source));
      const info = node('div', 'wb-request-info');
      info.append(pair('Started', record.time ? new Date(record.time).toLocaleTimeString() : 'Not recorded'), pair('Kind', record.kind || record.type || 'HTTP'), pair('Duration', durationLabel(record.duration)));
      if (record.id) info.append(pair('Request ID', String(record.id)));
      if (record.error) info.append(node('pre', '', String(record.error)));
      info.append(meta('Headers, request bodies and URL query values are not recorded.'));
      const related = (data.serverLogs || []).filter(entry => record.requestId && entry.requestId === record.requestId);
      if (related.length) info.append(node('pre', '', related.map(entry => entry.text || entry.message).join('\n')));
      details.append(summary, info); body.append(details);
    }
    if (!records.length) body.append(empty(query() ? 'No matching requests.' : 'No requests recorded yet. Use the page to see fetch, XHR and server requests.'));
    return body;
  }
  function metric(label, value, caption) { const metric = node('div', 'wb-metric'); metric.append(meta(label), node('strong', '', durationLabel(value))); if (caption) metric.append(meta(caption)); return metric; }
  function performance(data) {
    const body = node('div'), metrics = node('div', 'wb-metrics');
    const navigation = view.performance.getEntriesByType('navigation')[0];
    const builds = (data.builds || []).slice().reverse(), latest = builds[0];
    metrics.append(metric('Latest build', latest?.duration), metric('Page response', navigation ? navigation.responseStart - navigation.requestStart : undefined, 'Time to first byte'),
      metric('DOM ready', navigation?.domContentLoadedEventEnd || undefined));
    body.append(metrics);
    const build = section('Build timeline');
    if (!builds.length) build.append(empty('Build timings appear after the next compilation.'));
    for (const entry of builds.slice(0, 6)) {
      const details = node('details', 'wb-build'); details.dataset.key = 'build:' + (entry.buildId || entry.startedAt);details.open = entry === latest;
      const summary = node('summary'); summary.append(node('span', '', entry.reason || entry.kind || 'Compilation'), meta(durationLabel(entry.duration)));
      details.append(summary);
      for (const [name, duration] of Object.entries(entry.phases || {})) {
        if (typeof duration !== 'number') continue;
        const phase = node('div', 'wb-phase'), meter = node('span', 'wb-phase-meter'); meter.style.setProperty('--amount', Math.min(100, entry.duration ? duration / entry.duration * 100 : 0) + '%');
        phase.append(node('span', '', name), meter, meta(durationLabel(duration))); details.append(phase);
      }
      if (!Object.keys(entry.phases || {}).length) details.append(meta('This build has no phase measurements.'));
      build.append(details);
    }
    body.append(build);
    const network = section('Slowest resource loads');
    const resources = view.performance.getEntriesByType('resource').filter(entry => !/\/_prnext\/(?:dev|ensure)/.test(entry.name) && (!data.available || !entry.name.startsWith(tools.endpoint || 'http://invalid.invalid')))
      .sort((a, b) => b.duration - a.duration).slice(0, 8);
    for (const resource of resources) { const row = node('div', 'wb-tools-pair'); let path; try { path = new URL(resource.name).pathname; } catch { path = resource.name; } row.append(node('span', 'wb-truncate', path), meta(durationLabel(resource.duration))); network.append(row); }
    if (!resources.length) network.append(empty('No resource timings recorded.'));
    network.append(meta('Browser resource duration includes loading. Server render time is shown only when recorded by the runtime.'));
    body.append(network);
    const runtime = section('Runtime requests');
    const observed = (data.requests || []).filter(entry=>entry.source==='server').slice().sort((a,b)=>(b.duration||0)-(a.duration||0)).slice(0,8);
    for(const entry of observed) { const row=node('div','wb-tools-pair');row.append(node('span','wb-truncate',(entry.kind==='fetch'?'Server fetch · ':'HTTP · ')+(entry.path||'/')),meta(durationLabel(entry.duration)));runtime.append(row); }
    if(!observed.length)runtime.append(empty('No runtime request timings recorded yet.'));
    runtime.append(meta('Measured until response headers are ready; streamed body completion is not included.'));body.append(runtime);return body;
  }
  function routes(data) {
    const body = node('div'), records = (data.routes || []).filter(route => !query() || [route.path, route.kind, route.source].join(' ').toLocaleLowerCase().includes(query()));
    const cache = data.cache || {}, cacheSummary = node('div', 'wb-cache-summary');
    for (const [key, value] of Object.entries(cache)) if (['string', 'number', 'boolean'].includes(typeof value)) cacheSummary.append(pair(key.replace(/([A-Z])/g, ' $1'), String(value)));
    if (cacheSummary.childElementCount) body.append(cacheSummary);
    for (const route of records) {
      const details = node('details', 'wb-route'); details.dataset.key = 'route:' + route.path;details.open = selectedRoute === route.path;
      const summary = node('summary'); summary.append(node('code', '', route.path), meta(route.kind || 'route'), meta(route.compiled ? 'Compiled' : 'On demand'));
      details.addEventListener('toggle', () => { if (details.open) selectedRoute = route.path; else if (selectedRoute === route.path) selectedRoute = undefined; });
      const inner = node('div', 'wb-route-actions'), values = routeValues[route.path] ||= {};
      for (const parameter of routeParameters(route.path)) {
        const label = node('label', 'wb-route-param', parameter.name + (parameter.optional ? ' (optional)' : ''));
        const input = node('input'); input.value = values[parameter.name] || ''; input.placeholder = parameter.catchAll ? 'one/two' : parameter.name; input.autocomplete = 'off';
        input.addEventListener('input', () => { values[parameter.name] = input.value; }); label.append(input); inner.append(label);
      }
      const actions = node('div', 'wb-button-row');
      const open = button('Open route', () => action(open, async () => { const path = materializeRoute(route.path, values); await tools.call('dev_route_ensure', { path }); view.location.assign(path); }));
      const invalidate = button('Clear route cache', () => action(invalidate, async () => {
        const path = materializeRoute(route.path, values), result = await tools.call('dev_cache_invalidate', { path }); await tools.refresh(); return result;
      }, result => result?.invalidated === true ? 'Development cache invalidated for this route.' : result?.reason || 'No active development cache was invalidated.'));
      actions.append(open, invalidate);
      if (route.source) {
        const editor = button('Open source', () => action(editor, () => openEditor({ file: route.source, line: 1, column: 1 }), 'Editor link requested.')); actions.append(editor);
      }
      inner.append(actions); if (route.source) inner.append(meta(route.source)); details.append(summary, inner); body.append(details);
    }
    if (!records.length) body.append(empty(query() ? 'No matching routes.' : data.available ? 'No routes reported yet.' : 'Start PRNext dev to browse routes.'));
    return body;
  }
  const drawings = {
    target:'<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"/><path d="m9 8 6 4-3 1-1 3-2-8Z"/>',
    copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    plug:'<path d="M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5"/>',
  };
  function mark(paths, className='') {const result=node('span',className);result.innerHTML=svg(paths);return result;}
  async function copyText(text) {
    if (!view.navigator.clipboard?.writeText) throw Error('Clipboard unavailable. Select and copy the text below.');
    await view.navigator.clipboard.writeText(text);
  }
  function selectionView(initial) {
    const selection=node('section','wb-component');selection.setAttribute('aria-label',initial.kind==='error'?'Error context':'Selected element');
    const heading=node('div','wb-component-head'), identity=node('div','wb-component-identity'), name=node('h3'), kind=node('code','wb-component-kind');
    const labels=node('div');labels.append(name,kind);identity.append(mark(drawings.target,'wb-component-mark'),labels);
    const reselect=button('Reselect',()=>pick(),'wb-component-reselect');reselect.setAttribute('aria-label','Select another element');reselect.prepend(mark(drawings.target));heading.append(identity,reselect);
    const visual=node('div','wb-component-visual'), image=node('img','wb-selection-image');image.alt='Captured selected element';
    const placeholder=node('span','wb-component-placeholder');visual.append(image,placeholder);
    const sourceRow=node('div','wb-component-source'), location=node('code','wb-component-location'), editor=node('a','wb-component-editor','Open in editor');sourceRow.append(location,editor);
    const composer=node('div','wb-component-composer'), label=node('label','wb-component-label','What should change?');
    const prompt=node('textarea');prompt.rows=3;prompt.maxLength=4000;prompt.setAttribute('aria-label','Instruction for your assistant');prompt.placeholder='Describe the change…';prompt.value=instruction;prompt.addEventListener('input',()=>{instruction=prompt.value;});label.append(prompt);
    const footer=node('div','wb-component-compose-foot'), parts=node('span','wb-component-parts');
    const send=button('Send context to AI',()=>action(send,()=>tools.sendContext(tools.snapshot().context||context||initial,prompt.value),'Context is available to your assistant through PRNext MCP. Ask it to use the latest context.'),'wb-ai-primary');send.append(mark(drawings.arrow));footer.append(parts,send);composer.append(label,footer);
    const sourceDetails=node('details','wb-component-details');sourceDetails.dataset.key='component-source';sourceDetails.append(node('summary','','Source & styles'));
    const sourceCode=node('pre','wb-source-code'), styles=node('dl','wb-component-styles');sourceDetails.append(sourceCode,styles);
    selection.append(heading,visual,sourceRow,composer,sourceDetails);
    let lastImage,lastStyles;
    function sync(value) {
      const mapped=value.mappedSource,source=mapped?.file||(typeof value.source==='string'?value.source:''),file=source.split(/[\\/]/).pop()?.replace(/:\d+(?::\d+)?$/,'');
      name.textContent=file||(value.kind==='error'?'Runtime error':'Selected element');
      kind.textContent=value.kind==='error'?'Error':`<${value.tag||'element'}>${value.bounds?' · '+value.bounds.width+' × '+value.bounds.height:''}`;
      const png=value.screenshot?.mimeType==='image/png'&&typeof value.screenshot.data==='string'?value.screenshot:undefined;
      image.hidden=!png;placeholder.hidden=!!png;
      if(png&&lastImage!==png.data){image.src='data:image/png;base64,'+png.data;lastImage=png.data;}
      const pending=value.kind==='element'&&!Object.hasOwn(value,'screenshot');
      placeholder.textContent=value.kind==='error'?value.error?.message||value.text||'Runtime error':value.screenshotError||'Preparing preview…';
      visual.dataset.state=pending?'loading':value.kind==='error'?'error':png?'ready':'unavailable';
      location.textContent=mapped?.file?`${mapped.file}:${mapped.line}:${mapped.column}`:source||'Source unavailable';location.title=location.textContent;
      editor.hidden=!/^(?:vscode|cursor):\/\//.test(mapped?.editorUrl||'');if(!editor.hidden)editor.href=mapped.editorUrl;
      sourceCode.textContent=(value.kind==='error'&&value.error?.stack?value.error.stack+'\n\n':'')+(mapped?.frame||(Array.isArray(mapped?.excerpt)?mapped.excerpt.map(line=>`${line.line} ${line.text}`).join('\n'):mapped?.error||'Source is being resolved.'));
      const nextStyles=JSON.stringify(value.styles||{});if(nextStyles!==lastStyles){lastStyles=nextStyles;styles.replaceChildren();for(const [key,text]of Object.entries(value.styles||{}))styles.append(node('dt','',key),node('dd','',text));}
      parts.textContent=pending?'Preparing context…':[mapped?.file&&'Source',value.styles&&'Styles',png&&'Screenshot'].filter(Boolean).join(' · ')||'Error context';
      const connected=assistantConnected();reselect.disabled=busy;
      send.disabled=busy||pending||!connected;send.title=!connected?'Connect your assistant first.':pending?'Wait for the source and preview to finish.':'Queue this context for your assistant';
    }
    sync(initial);return {node:selection,sync};
  }
  function ai(data) {
    const body=node('div','wb-ai-layout'),current={...(connection||{}),...(data.ai||{})},currentContext=data.context||context;
    const state=node('section','wb-ai-connect'),hero=node('div','wb-ai-hero'),heading=node('h3','wb-ai-heading'),description=node('p','wb-ai-description');
    const badge=node('span','wb-ai-status'),badgeText=node('span','wb-ai-status-label');badge.append(node('i'),badgeText);badge.setAttribute('aria-live','polite');badge.setAttribute('aria-atomic','true');
    hero.append(heading,description,badge);state.append(hero);
    const setup=node('details','wb-ai-setup'),setupSummary=node('summary','','Connection settings'),setupContent=node('div','wb-ai-setup-content');setup.dataset.key='ai-setup';setup.append(setupSummary,setupContent);state.append(setup);
    const host=node('div','wb-host-connect'),hostHead=node('div','wb-host-heading');
    hostHead.append(mark(drawings.plug),node('strong','','Use your PRNext MCP'));
    const hostState=node('span','wb-host-state',current.hostRelay?.linked?'Relay ready':'Existing connection');hostHead.append(hostState);
    const command=node('div','wb-host-command');command.append(node('code','','prnext dev --host-ai'));
    const copyCommand=button('',()=>action(copyCommand,()=>copyText('prnext dev --host-ai'),'Host command copied.'),'wb-host-copy');copyCommand.setAttribute('aria-label','Copy Host command');copyCommand.title='Copy command';copyCommand.append(mark(drawings.copy));command.append(copyCommand);
    const relayError=node('p','wb-error-text wb-host-error');relayError.hidden=true;
    host.append(hostHead,command,node('p','wb-host-note','Shares this dev session through your existing PRNext login.'));setupContent.append(host);state.append(relayError);
    const divider=node('div','wb-ai-divider');divider.append(node('span','','Or connect this project'));setupContent.append(divider);
    const chooser=node('div','wb-ai-clients');chooser.setAttribute('role','group');chooser.setAttribute('aria-label','AI client');
    const details=node('details','wb-mcp-config wb-local-setup');details.dataset.key='mcp';
    const summary=node('summary','','Local MCP configuration'),controls=node('div','wb-mcp-controls'),format=node('span','wb-mcp-format'),code=node('pre','wb-mcp-code');
    const reveal=node('div','wb-mcp-reveal'),mcpContent=node('div','wb-mcp-content'),snippet=node('div','wb-mcp-snippet');
    const help=button('',undefined,'wb-mcp-help-toggle');help.setAttribute('aria-label','MCP setup help');help.title='Where to put this configuration';help.append(mark('<circle cx="12" cy="12" r="8"/><path d="M12 11v5m0-9v.01"/>'));
    const helpReveal=node('div','wb-mcp-help-reveal'),helpContent=node('div','wb-mcp-help'),helpText=node('p'),helpNote=node('p','','Keep prnext dev running on this computer.'),helpLink=node('a','','Setup guide ↗');
    helpReveal.id='prnext-mcp-help-'+(++aiViewId);help.setAttribute('aria-controls',helpReveal.id);helpLink.target='_blank';helpLink.rel='noopener noreferrer';helpContent.append(helpText,helpNote,helpLink);helpReveal.append(helpContent);
    code.tabIndex=0;code.setAttribute('role','region');code.setAttribute('aria-label','MCP configuration');
    let mcp=current.mcp,mcpSignature=JSON.stringify(mcp);
    const copy=button('',()=>action(copy,()=>copyText(formatMcpConfig(mcp,mcpClient)),'MCP configuration copied.'),'wb-config-copy');copy.setAttribute('aria-label','Copy MCP configuration');copy.title='Copy configuration';copy.prepend(mark(drawings.copy));
    controls.append(format,help);snippet.append(code,copy);mcpContent.append(controls,helpReveal,snippet);reveal.append(mcpContent);details.append(summary,reveal);
    const configDisclosure=disclosure(summary,reveal,mcpContent,details),helpDisclosure=disclosure(help,helpReveal,helpContent);disposeAiView=()=>{configDisclosure.dispose();helpDisclosure.dispose();};
    const providerButtons=new Map(),formats={codex:'Codex · TOML',cursor:'Cursor · JSON',claude:'Claude Desktop · JSON',other:'Other MCP · JSON'};
    function syncProvider(){
      for(const[id,control]of providerButtons)control.setAttribute('aria-pressed',String(id===mcpClient));
      format.textContent=formats[mcpClient];code.textContent=mcp?formatMcpConfig(mcp,mcpClient):'Start PRNext dev to get the local configuration.';
      const guide=mcpGuides[mcpClient];helpText.textContent=guide.text;helpLink.href=guide.url;code.scrollTop=0;
      copy.disabled=!mcp;
    }
    function choose(id){const changed=id!==mcpClient;mcpClient=id;syncProvider();configDisclosure.set(true);if(changed&&!view.matchMedia('(prefers-reduced-motion: reduce)').matches){mcpContent.style.transition='none';mcpContent.dataset.swapping='true';void mcpContent.offsetHeight;mcpContent.style.removeProperty('transition');mcpContent.dataset.swapping='false';}}
    for(const brand of devAiBrands){
      const label=brand.id==='claude'?'Claude':brand.label,control=button('',()=>choose(brand.id),'wb-ai-client');control.setAttribute('aria-label',label);control.dataset.client=brand.id;
      const logo=node('span','wb-ai-client-logo');logo.innerHTML=brand.icon;
      const tick=mark(drawings.check,'wb-ai-client-check');control.append(logo,node('span','wb-ai-client-label',label),tick);control.disabled=!current.mcp;chooser.append(control);providerButtons.set(brand.id,control);
    }
    const other=button('Other MCP',()=>choose('other'),'wb-ai-other');other.setAttribute('aria-label','Other MCP');const otherLogo=node('span');otherLogo.innerHTML=devMcpBrand.icon;other.prepend(otherLogo);other.disabled=!current.mcp;providerButtons.set('other',other);
    syncProvider();setupContent.append(chooser,other,details);body.append(state);
    const workspace=node('section','wb-ai-workspace'),ready=node('div','wb-ai-ready');
    const select=button('Select an element',()=>pick(),'wb-ai-primary wb-ai-select');select.prepend(mark(drawings.target));
    ready.append(select,node('p','','Choose a component to describe a change.'));workspace.append(ready);body.append(workspace);
    let selection,wasConnected,resumePrompt=false;
    const verify=node('section','wb-ai-verify'),verifyText=node('div');verifyText.append(node('strong','','Check your changes'),node('p','','Confirm the latest build in your browser.'));
    const check=button('Verify page',()=>action(check,()=>{const latest=tools.snapshot();if(!assistantConnected(latest))throw Error('Connect your assistant first.');return tools.call('dev_verify',{path:view.location.pathname,sinceSequence:Math.max(0,(latest.sequence||1)-1),clientId:latest.clientId,timeoutMs:25000});},result=>result.verified===true||result.ok===true||result.state==='verified'?'Verified: the browser applied the build and no current errors were reported.':result.reason||result.message||'Verification is incomplete. Check the browser and current errors.'),'wb-ai-verify-button');check.prepend(mark(drawings.check));verify.append(verifyText,check);body.append(verify);
    syncAiView=latest=>{
      const live={...(connection||{}),...(latest.ai||{})},online=latest.connection==='connected',connected=assistantConnected(latest),value=latest.context||context||currentContext;
      heading.textContent=connected?'Assistant connected':'Connect your assistant';
      const signature=JSON.stringify(live.mcp);if(signature!==mcpSignature){mcp=live.mcp;mcpSignature=signature;syncProvider();for(const control of providerButtons.values())control.disabled=!mcp;}
      description.textContent=connected?String(live.client||'Local MCP session'):!online&&live.connected?'Reconnect your local dev session.':'Connect to send your selection to an assistant.';
      badge.dataset.connected=String(connected);badgeText.textContent=!online?latest.connection==='unavailable'?'Unavailable':'Reconnecting':connected?'Connected':live.hostRelay?.linked?'Waiting for assistant':'Not connected';
      hostState.textContent=online&&live.hostRelay?.linked?'Relay ready':'Existing connection';relayError.textContent=live.hostRelay?.error||'';relayError.hidden=!relayError.textContent;
      let focusSetup=false,focusWorkspace=false;
      if(wasConnected!==connected){
        focusWorkspace=connected&&wasConnected===false&&setup.contains(shadow.activeElement);
        setup.open=!connected;
        if(wasConnected===true&&!connected){
          resumePrompt=workspace.contains(shadow.activeElement);focusSetup=resumePrompt||verify.contains(shadow.activeElement)||shadow.activeElement===setupSummary;
          setFeedback('Assistant disconnected. Reconnect to continue.');
        }
      }
      setupSummary.hidden=!connected;workspace.hidden=!connected;verify.hidden=!connected;check.disabled=!connected||busy;select.disabled=!connected||busy;
      body.dataset.connected=String(connected);body.classList.toggle('wb-ai-has-selection',connected&&!!value);
      if(connected&&value){if(!selection){selection=selectionView(value);workspace.replaceChildren(selection.node);}selection.sync(value);}
      else if(selection&&value)selection.sync(value);
      if(focusSetup)copyCommand.focus({preventScroll:true});
      if(connected&&resumePrompt){(workspace.querySelector('textarea')||workspace.querySelector('button'))?.focus({preventScroll:true});resumePrompt=false;}
      else if(focusWorkspace)(workspace.querySelector('textarea')||workspace.querySelector('button'))?.focus({preventScroll:true});
      if(connected&&wasConnected===false&&/^(?:Assistant disconnected\.|Connect your assistant\b|Your assistant is no longer connected\.)/.test(feedback.textContent))setFeedback('');
      wasConnected=connected;
    };syncAiView(data);return body;
  }
  function render(force = false) {
    if (disposed || !dialog.open) return;
    const data = tools.snapshot(); status.textContent = data.connection === 'connected' ? 'Local' : data.connection === 'unavailable' ? 'Unavailable' : 'Reconnecting';
    const selectionReady=active==='ai'&&assistantConnected(data)&&!!(data.context||context);
    dialog.dataset.panel=active;dialog.dataset.selection=String(selectionReady);
    title.textContent=selectionReady?(data.context||context).kind==='error'?'Debug with AI':'Selected component':headings[active];
    if(active==='ai')syncAiView?.(data);
    // Avoid replacing a focused field or open details every heartbeat.
    const signature = JSON.stringify([active, filter.value, data.requests?.at(-1)?.id, data.localRequests?.at(-1)?.id, data.builds?.at(-1)?.buildId, data.routes, data.cache,
      data.context?.source, data.context?.screenshot?.data?.length, data.context?.screenshotError, data.context?.sent,
      data.ai?.connected, data.ai?.lastActivity, data.ai?.hostRelay, data.ai?.contexts?.at(-1)?.id]);
    if (!force && signature === lastSignature) return;
    if (!force && content.contains(shadow.activeElement)) return;
    lastSignature = signature; const openDetails=new Map([...content.querySelectorAll('details[data-key]')].map(details=>[details.dataset.key,details.prnextExpand?details.dataset.expanded==='true':details.open]));
    disposeAiView?.();disposeAiView=undefined;syncAiView=undefined;
    content.replaceChildren(({ requests, performance, routes, ai })[active](data));
    for(const details of content.querySelectorAll('details[data-key]'))if(openDetails.has(details.dataset.key)){const expanded=openDetails.get(details.dataset.key);if(details.prnextExpand)details.prnextExpand(expanded,{animate:false});else details.open=expanded;}
    if (data.error && !feedback.textContent) setFeedback(data.error);
  }
  async function load(force=false) {
    if (refreshing) return; refreshing = true; refresh.disabled = true;
    try { await tools.refresh(); if (active === 'ai') connection = await tools.call('dev_connection'); render(force); }
    catch (error) { setFeedback(error.message); }
    finally { refreshing = false; refresh.disabled = false; }
  }
  function open(key = 'requests', nextContext) {
    if (disposed) return;
    if (picker) { picker.dispose(); picker = undefined; }
    if (nextContext) { context = nextContext; tools.setContext(nextContext); }
    const changed = active !== key; active = key; title.textContent = headings[key];
    for (const item of nav.children) { item.setAttribute('aria-current', item.dataset.panel === key ? 'page' : 'false'); }
    filter.hidden = !['requests', 'routes'].includes(key); filter.placeholder = key === 'routes' ? 'Find a route…' : 'Filter requests…'; filter.setAttribute('aria-label', key === 'routes' ? 'Find a route' : 'Filter requests');
    if (changed) { filter.value = ''; setFeedback(''); }
    if (!dialog.open) { dialog.showModal(); stop = tools.watch(); unsubscribe = tools.subscribe(() => render()); }
    render(true);
    const selected=nav.querySelector('[aria-current=page]');
    if(selected&&active!=='ai'){const item=selected.getBoundingClientRect(),bounds=nav.getBoundingClientRect();if(item.right>bounds.right-8)nav.scrollLeft+=item.right-bounds.right+8;else if(item.left<bounds.left+8)nav.scrollLeft-=bounds.left+8-item.left;}
    void load(); if (!filter.hidden) filter.focus(); else if(nextContext)(content.querySelector('.wb-ai-workspace:not([hidden]) textarea')||content.querySelector('.wb-host-copy'))?.focus({preventScroll:true});else close.focus();
  }
  function pick() {
    if(disposed)return;
    const epoch=++pickEpoch;
    if (dialog.open) dialog.close();
    let shown = false;
    picker?.dispose(); picker = createElementPicker({ tools, view, onCancel(){picker=undefined;restoreFocus();}, onSelect(selection) {
      if(disposed||epoch!==pickEpoch)return;if(!shown)instruction='';context = selection; picker = undefined;
      if(shown){if(dialog.open&&active==='ai')render();return;}shown=true;open('ai', selection);
    } });
  }
  filter.addEventListener('input', () => render(true));
  content.addEventListener('focusout',()=>view.requestAnimationFrame(()=>render()));
  dialog.addEventListener('close', () => { stop?.(); stop = undefined; unsubscribe?.(); unsubscribe = undefined; restoreFocus(); });
  return { open, pick, hide() { pickEpoch++;if (dialog.open) dialog.close();picker?.dispose(); picker = undefined; },
    dispose() { disposed = true;pickEpoch++;picker?.dispose(); stop?.(); unsubscribe?.();disposeAiView?.(); dialog.remove(); style.remove(); },
  };
}
