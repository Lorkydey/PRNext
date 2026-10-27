import Refresh from 'react-refresh/runtime';
import { createDevIndicator } from './dev-indicator.mjs';
import { createConsoleCapture, isDevicePreview } from './dev-console.mjs';
import { createDevToolsClient } from './dev-tools-client.mjs';
import { createDevErrorOverlay } from './dev-error-overlay.mjs';
import { collectDevIssues, formatDevIssuesForAI } from './dev-error-report.mjs';

const state = globalThis.__PRNEXT_DEV__ ||= {
  applications: new Map(), modules: new Map(), buildId: null, manifest: null,
  pending: null, applying: false, unsafe: false, queued: null, source: null,
};
// Install before application bootstrap so initial renders/effects are captured.
if (!state.consoleCapture && !state.consoleDisabled) state.consoleCapture = createConsoleCapture();
if (!state.injected) { Refresh.injectIntoGlobalHook(globalThis); state.injected = true; }
export const register = (type, id) => Refresh.register(type, id);
export const signature = () => Refresh.createSignatureFunctionForTransform();
export function registerModule(id, hash, boundary) {
  const previous = state.modules.get(id);
  if (state.applying && (!previous || previous.hash !== hash)) state.refreshSourceChanged = true;
  if (previous && previous.hash !== hash && (!previous.boundary || !boundary)) state.unsafe = true;
  state.modules.set(id, { hash, boundary });
}

function clearError({ dismiss = false } = {}) {
  state.errorOverlay?.dispose();state.errorOverlay=undefined;
  document.getElementById('__prnext_dev_error__')?.remove(); state.overlayError = undefined;
  clearTimeout(state.errorCopyTimer);state.errorCopyTimer=undefined;
  state.errorEntry=undefined;state.errorReport=undefined;state.errorSource=undefined;
  state.overlaySelectedId=undefined;state.overlayKind=undefined;state.overlayIssues=undefined;state.errorSources=undefined;
  if (!dismiss) state.issue = undefined;
  state.indicator?.update();
}
function dismissError() {
  if(state.overlayError&&typeof state.overlayError==='object')(state.dismissedErrors ||= new WeakSet()).add(state.overlayError);
  const key=errorKey(state.overlayError);
  if(key){const entries=state.dismissedDigests ||= new Set();if(entries.size>=32)entries.delete(entries.values().next().value);entries.add(key);}
  if(state.overlayKind==='typescript')state.dismissedTypeDiagnostic=state.lastTypeDiagnostic;
  clearError({dismiss:true});
  let focused=document.activeElement;
  while(focused?.shadowRoot?.activeElement)focused=focused.shadowRoot.activeElement;
  if(!focused||focused===document.body||focused===document.documentElement||focused.closest?.('[inert]'))document.getElementById('__prnext_dev_tools__')?.shadowRoot?.querySelector('.trigger')?.focus({preventScroll:true});
}
function errorKey(error) {
  return typeof error?.digest === 'string' ? `${error.digest.slice(0, 256)}:${String(error.message || '').slice(0, 512)}` : null;
}
function reportRecoverableError(error, info) {
  const message=String(error?.message||error).slice(0,48*1024);
  const key=message.replace(/^(?:Uncaught\s+)?Error:\s*/,'').split(/\n\s+at\s+/)[0].replace(/\r\n/g,'\n').trim();
  if(state.recoverableKey===key)return;
  // Keep one current diagnostic; the console retains the complete history.
  // Never replace a blocking issue or open an overlay during successful recovery.
  state.recoverableKey=key;
  state.recoverableIssue={name:String(error?.name||'Error'),message,stack:String(error?.stack||message+(info?.componentStack||'')).slice(0,48*1024)};
  if(state.errorOverlay)syncErrorOverlay();
  state.indicator?.update();
}
function showError(error, { retain = true } = {}) {
  if(error===null||error===undefined)error=new Error(String(error));
  const key = errorKey(error);
  if (error && typeof error === 'object' && (state.dismissedErrors?.has(error) || (key && state.dismissedDigests?.has(key)))) return;
  if(retain){state.issue=error;if(error!==state.lastTypeDiagnostic)state.issueKind=state.devBuildState==='error'?'build':'runtime';}
  state.indicator?.update();
  syncErrorOverlay({preferredError:error,open:true});
}
function hasCriticalIssue(){return state.issue!==undefined&&state.issue!==state.lastTypeDiagnostic;}
function syncErrorOverlay({preferredError,selectedId,open=false}={}) {
  if(!open&&!state.errorOverlay)return;
  const {issues,omitted}=collectDevIssues({critical:hasCriticalIssue()?state.issue:undefined,criticalKind:state.issueKind||'runtime',typeErrors:state.typeErrors,recoverable:state.recoverableIssue});
  if(!issues.length){clearError();return;}
  const selected=issues.find(issue=>issue.id===selectedId)
    ||issues.find(issue=>issue.error===preferredError)
    ||(preferredError===state.lastTypeDiagnostic&&preferredError!==undefined?issues.find(issue=>issue.kind==='typescript'&&issue.id===state.overlaySelectedId)||issues.find(issue=>issue.kind==='typescript'):undefined)
    ||issues.find(issue=>issue.id===state.overlaySelectedId)||issues[0];
  const changed=!state.errorOverlay?.host.isConnected||!state.errorEntry||state.errorEntry.id!==selected.id||state.errorEntry.error!==selected.error||state.errorReport.message!==selected.report.message||state.errorReport.stack!==selected.report.stack||state.overlayKind!==selected.kind;
  state.overlayIssues={issues,omitted};state.overlaySelectedId=selected.id;state.overlayKind=selected.kind;state.overlayError=selected.error;
  const sources=state.errorSources ||= new Map();for(const [id,cached]of sources)if(!issues.some(issue=>issue.id===id&&issue.error===cached.error&&issue.report.message===cached.report?.message&&issue.report.stack===cached.report?.stack))sources.delete(id);
  if(!state.errorOverlay?.host.isConnected){
    state.errorOverlay?.dispose();
    state.errorOverlay=createDevErrorOverlay({onDismiss:dismissError,onSendToAI(){
      const detail={kind:'error',error:state.errorReport,source:state.errorSource};
      dismissError();
      globalThis.dispatchEvent(new CustomEvent('prnext:devtools:ai',{detail}));
    },onSelectIssue(id){syncErrorOverlay({selectedId:id});},onCopyForAI(){void copyErrorsForAI();}});
  }
  const overlay=state.errorOverlay;
  if(changed){state.errorEntry=selected;state.errorReport=selected.report;state.errorSource=undefined;}
  overlay.render(state.errorReport,{recoverable:selected.recoverable,kind:selected.kind,issues,selectedId:selected.id,omitted});
  if(!changed)return;
  const entry=state.errorEntry,cached=sources.get(selected.id);
  if(cached){state.errorSource=cached.source;overlay.setSource(cached.source);overlay.setSourceStatus(cached.source.mapped?'':'Original source location.');return;}
  overlay.setSourceStatus(state.tools?'Locating original source…':'');
  if(state.tools)void state.tools.call('dev_source',{stack:state.errorReport.stack,error:state.errorReport}).then(source=>{
    if(state.errorEntry!==entry||state.errorOverlay!==overlay||!overlay.host.isConnected)return;
    sources.set(selected.id,{error:selected.error,report:entry.report,source});
    state.errorSource=source;overlay.setSource(source);
    overlay.setSourceStatus(source.mapped?'':'Original source location.');
  }).catch(()=>{if(state.errorEntry===entry&&state.errorOverlay===overlay&&overlay.host.isConnected)overlay.setSourceStatus('Original source unavailable. Full details remain below.');});
}
async function copyErrorsForAI(){
  const overlay=state.errorOverlay,current=state.overlayIssues;if(!overlay||!current)return;
  try{
    const sourceById=new Map([...(state.errorSources||[])].map(([id,cached])=>[id,cached.source]));
    const prompt=formatDevIssuesForAI(current.issues,{route:location.pathname,sourceById,omitted:current.omitted});
    if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable');
    await navigator.clipboard.writeText(prompt);
    if(state.errorOverlay===overlay){overlay.setCopyStatus('copied');clearTimeout(state.errorCopyTimer);state.errorCopyTimer=setTimeout(()=>{if(state.errorOverlay===overlay)overlay.setCopyStatus('idle');},1800);}
  }catch{if(state.errorOverlay===overlay)overlay.setCopyStatus('error');}
}

function reload(reason) {
  try{sessionStorage.setItem('__prnext_reload_reason__',reason);}catch{}
  void state.tools?.browser('reload',{reason});
  globalThis.dispatchEvent(new CustomEvent('prnext:reload',{detail:{reason}}));
  location.reload();
}
function showReloadReason(){
  let reason;try{reason=sessionStorage.getItem('__prnext_reload_reason__');sessionStorage.removeItem('__prnext_reload_reason__');}catch{}
  if(!reason)return;
  const note=document.createElement('div');note.id='__prnext_reload_reason__';note.setAttribute('role','status');note.textContent=reason;
  Object.assign(note.style,{position:'fixed',bottom:'76px',left:'18px',maxWidth:'min(360px,calc(100vw - 36px))',padding:'10px 14px',border:'1px solid #292929',borderRadius:'10px',background:'#080808',color:'#ddd',font:'12px/1.5 system-ui',zIndex:'2147483646'});
  document.documentElement.append(note);setTimeout(()=>note.remove(),6500);
}

async function updateStyles(urls) {
  const wanted = new Set(urls.map(url => new URL(url, location.href).href));
  const old = [...document.querySelectorAll('link[rel="stylesheet"]')].filter(link => link.href.includes('/_prnext/assets/'));
  const existing = new Set(old.map(link => link.href));
  await Promise.all([...wanted].filter(href => !existing.has(href)).map(href => new Promise((resolve, reject) => {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href;
    const timer = setTimeout(() => { link.remove(); reject(new Error('Stylesheet update timed out')); }, 15_000);
    link.onload = () => { clearTimeout(timer); resolve(); };
    link.onerror = () => { clearTimeout(timer); link.remove(); reject(new Error(`Could not load updated stylesheet ${href}`)); };
    document.head.append(link);
  })));
  for (const link of old) if (!wanted.has(link.href)) link.remove();
}

function typeDiagnostics(errors) {
  state.typeErrors=errors;
  if(!errors.length){
    if(state.lastTypeDiagnostic!==undefined&&state.issue===state.lastTypeDiagnostic){
      state.issue=undefined;
    }
    state.lastTypeDiagnostic=undefined;state.dismissedTypeDiagnostic=undefined;if(state.errorOverlay)syncErrorOverlay();state.indicator?.update();return;
  }
  const text=errors.join('\n');
  const previous=state.lastTypeDiagnostic;
  const critical=state.issue!==undefined&&state.issue!==previous;
  state.lastTypeDiagnostic=text;
  if(!critical)state.issue=text;
  if(!critical&&state.dismissedTypeDiagnostic!==text&&(!state.overlayError||state.overlayKind==='typescript'))showError(text);
  else if(state.errorOverlay)syncErrorOverlay();
  state.indicator?.update();
}
async function applyUpdate(message, {navigation=false}={}) {
  if(message.session&&state.session&&message.session!==state.session){reload('Development server restarted. Page reloaded.');return;}
  if(message.sequence&&message.sequence<=(state.sequence||0))return;
  if (state.applying) {
    if(!state.queued||(message.sequence||0)>=(state.queued.sequence||0))state.queued={...message,navigation};
    const pending=state.applied;await pending;
    if((message.sequence||0)>(state.sequence||0)&&state.applying)await state.applied;
    return;
  }
  if (!message.clientManifest) { reload('Refresh metadata changed. Page reloaded.'); return; }
  const changed = message.changed || [];
  if (changed.some(file => /(?:^|\/)(?:(?:next|prnext)\.config\.|package(?:-lock)?\.json|\.env|pages\/_document\.)/.test(file))) { reload('Project configuration changed. Page reloaded.'); return; }
  // An initial dynamic import/bootstrap failure has no mounted application to
  // update. Retry once on a newer successfully compiled build, not repeatedly
  // on reconnects or readiness messages for the same failed generation.
  if(state.bootstrapFailed&&message.buildId!==state.bootstrapFailed.buildId){
    state.bootstrapFailed=undefined;
    reload('Application startup failed. Page reloaded after a successful rebuild.');return;
  }
  const refreshStarted=performance.now();
  const localPath=location.pathname.slice((state.basePath||'').length)||'/';
  const affected=message.affectedRoutes;
  if(state.confirmed&&affected&&!affected.some(pattern=>pattern.includes('[')||pattern===localPath||pattern+'/'===localPath)){
    state.buildId=message.buildId;state.sequence=message.sequence;state.lastRefresh={buildId:message.buildId,durationMs:0,changed,skipped:true};
    document.documentElement.dataset.prnextDevBuild=message.buildId;
    if(hasCriticalIssue()&&state.issueKind==='build'){clearError();if(state.typeErrors)typeDiagnostics(state.typeErrors);}
    state.indicator?.update();
    globalThis.dispatchEvent(new CustomEvent('prnext:refresh',{detail:state.lastRefresh}));return;
  }
  state.applying = true; state.confirmed=false; state.unsafe = false; state.refreshSourceChanged = false; state.pending = null; state.indicator?.update();
  let applied;state.applied=new Promise(resolve=>{applied=resolve;});
  state.dismissedErrors = new WeakSet();
  state.dismissedDigests = new Set();
  try {
    const response = await fetch(message.clientManifest, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Development manifest failed (${response.status})`);
    const manifest = await response.json();
    if (manifest.buildId !== message.buildId) throw new Error('Development build changed during refresh');
    const kind = state.currentKind;
    const application = await state.applications.get(kind);
    const route = kind === 'pages' ? manifest.pages.find(route => route.pattern === application.router.snapshot().pathname) : null;
    const entry = kind === 'pages' ? route?.client : manifest.app?.client;
    if (!entry) { reload('The current route changed. Page reloaded.'); return; }
    if(!message.cssOnly)await import(/* webpackIgnore: true */ entry);
    const pending = state.pending;
    if (pending) await application.devPrepare?.(pending.options);
    if (state.unsafe) { reload('An edited module exports values outside React components. Page reloaded.'); return; }
    if (kind === 'app' && application.devPrepareStyles) await application.devPrepareStyles(manifest.app.routes);
    else await updateStyles(kind === 'pages' ? route.css : application.devStyles?.(manifest.app.routes) || manifest.app.css);
    if (kind === 'app') application.devStylesApplied?.(manifest.app.routes, { commit: !!message.cssOnly || !pending });
    // An unrelated type-only edit may publish a new generation without changing
    // any browser module. Keep its existing runtime/hydration issues and current
    // selection until application code changes, rather than racing diagnostics.
    if(state.refreshSourceChanged||navigation){
      state.recoverableIssue=undefined;state.recoverableKey=undefined;
      clearError();
    }else if(hasCriticalIssue()&&(state.issueKind==='build'||errorKey(state.issue))){
      clearError();
    }
    if(!message.cssOnly)Refresh.performReactRefresh();
    if (pending) await (navigation ? application.devSync?.(pending.options) : application.devCommit?.(pending.options));
    state.buildId = message.buildId;
    if(message.sequence)state.sequence=message.sequence;
    state.manifest = manifest;
    document.documentElement.dataset.prnextDevBuild = message.buildId;
    state.lastRefresh={buildId:message.buildId,durationMs:Math.round(performance.now()-refreshStarted),changed};
    await painted();state.confirmed=true;
    globalThis.dispatchEvent(new CustomEvent('prnext:refresh', { detail: state.lastRefresh }));
    globalThis.dispatchEvent(new CustomEvent('prnext:devtools:ready'));
    if(state.typeErrors)typeDiagnostics(state.typeErrors);
  } catch (error) { showError(error); }
  finally {
    state.applying = false; state.pending = null; state.indicator?.update();
    applied();
    if (state.queued) { const queued = state.queued; state.queued = null; if (queued.buildId !== state.buildId) void applyUpdate(queued,{navigation:queued.navigation}); }
  }
}

function connect(options) {
  state.basePath=options.basePath||'';
  if (state.source) return;
  state.buildId = options.dev.buildId;
  state.sequence=options.dev.sequence||0;state.session=options.dev.session;
  state.clientId ||= crypto.randomUUID();
  state.onDemand=options.dev.onDemand===true;
  state.devConnection = 'connecting'; state.devBuildState = 'ready';
  if (options.dev.indicator === false) { state.consoleCapture?.dispose(); state.consoleCapture = null; state.consoleDisabled = true; }
  const snapshot=()=>({connection:state.devConnection,building:state.devBuildState==='building'||state.applying,confirmed:state.confirmed===true,router:state.currentKind,buildId:state.buildId,sequence:state.sequence,typeErrors:state.typeErrors?.length||0,issues:(state.typeErrors?.length||0)+(hasCriticalIssue()?1:0)+(state.recoverableIssue?1:0),criticalIssues:hasCriticalIssue()?1:0,lastRefresh:state.lastRefresh});
  state.tools ||= createDevToolsClient({capture:state.consoleCapture,snapshot,config:options.dev.tools||options.devTools});
  showReloadReason();
  if (options.dev.indicator !== false && !isDevicePreview() && !state.indicator) state.indicator = createDevIndicator({
    tools:state.tools,
    position: options.dev.indicator?.position,
    capture: state.consoleCapture,
    snapshot: () => ({
      connection: state.devConnection, building: state.devBuildState === 'building' || state.applying,
      router: state.currentKind, buildId: state.buildId, sequence: state.sequence,
      typeErrors: state.typeErrors?.length || 0,
      issues: (state.typeErrors?.length || 0) + (hasCriticalIssue() ? 1 : 0) + (state.recoverableIssue ? 1 : 0),
      criticalIssues: hasCriticalIssue() ? 1 : 0,
    }),
    showIssues() {
      const critical=hasCriticalIssue();
      const error = critical?state.issue:state.recoverableIssue||state.issue||state.lastTypeDiagnostic;
      if (error===undefined||error===null) return;
      if (typeof error === 'object') state.dismissedErrors?.delete(error);
      const key = errorKey(error); if (key) state.dismissedDigests?.delete(key);
      state.dismissedTypeDiagnostic = undefined; showError(error,{retain:error!==state.recoverableIssue});
      state.errorOverlay?.focusDismiss();
    },
  });
  if (isDevicePreview()) { try { parent.postMessage({type:'prnext:preview-ready'}, location.origin); } catch {} }
  state.ensureRoute=async raw=>{
    if(!state.onDemand)return;
    const url=new URL(raw,location.href);if(url.origin!==location.origin)return;
    state.ensuring=(state.ensuring||0)+1;
    try{
    const response=await fetch(`${options.basePath||''}/_prnext/ensure?client=${state.clientId}&path=${encodeURIComponent(url.pathname+url.search)}`,{cache:'no-store',credentials:'same-origin'});
    if(!response.ok)throw Error(await response.text());
    const update=await response.json();
    if(update.buildId!==state.buildId)await applyUpdate(update,{navigation:true});
    }finally{state.ensuring--;}
  };
  const source = new EventSource(`${options.basePath || ''}/_prnext/dev?client=${state.clientId}&path=${encodeURIComponent(location.pathname+location.search)}`);
  state.source = source;
  source.onopen = () => { state.devConnection = 'connected'; state.indicator?.update(); };
  source.onerror = () => { state.devConnection = 'reconnecting'; state.indicator?.update(); };
  source.onmessage = event => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if(message.session&&state.session&&message.session!==state.session){reload('Development server restarted. Page reloaded.');return;}
    state.devBuildState = message.state; state.indicator?.update();
    if(Array.isArray(message.typeErrors))typeDiagnostics(message.typeErrors);
    if (message.state === 'error') { showError(message.error || 'Build failed'); return; }
    if (message.state !== 'ready') return;
    if (message.buildId === state.buildId) return;
    // A cold navigation may receive SSE readiness before its ensure response.
    // Updating modules is safe; refreshing the old route would cancel the click.
    void applyUpdate(message,{navigation:state.ensuring>0});
  };
  globalThis.addEventListener('error', event => { if (event.error) showError(event.error); });
  globalThis.addEventListener('unhandledrejection', event => showError(event.reason));
  globalThis.addEventListener('pagehide', () => {source.close();state.tools?.dispose();state.stopHydrationDiagnostics?.();}, { once: true });
}

state.reportError = showError;
state.reportRecoverableError = reportRecoverableError;
if(state.consoleCapture&&!state.stopHydrationDiagnostics){
  let serial=0;
  // Attribute-only hydration mismatches are reported by React through console,
  // without invoking onRecoverableError. Match its diagnostic, not arbitrary logs.
  state.stopHydrationDiagnostics=state.consoleCapture.subscribe(()=>{
    for(const entry of state.consoleCapture?.snapshot().entries||[]){
      if(entry.id<=serial)continue;serial=entry.id;
      if((entry.level==='error'||entry.level==='warn')&&entry.text.includes('https://react.dev/link/hydration-mismatch')&&/Hydration failed|A tree hydrated/i.test(entry.text))reportRecoverableError(entry.text);
    }
  });
}
function painted(){return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}
state.bootstrap = (kind, options, start) => {
  state.currentKind = kind;
  if (!state.applications.has(kind)) {
    state.confirmed=false;
    const application = Promise.resolve().then(start);
    state.applications.set(kind, application);
    connect(options);
    application.then(async current=>{await current.devReady;await painted();if(!state.applying){state.confirmed=true;globalThis.dispatchEvent(new CustomEvent('prnext:devtools:ready'));}},error=>{
      state.bootstrapFailed={kind,buildId:options.dev.buildId};state.confirmed=false;showError(error);
    }).catch(showError);
  } else if (state.applying) state.pending = { kind, options };
  return state.applications.get(kind);
};
