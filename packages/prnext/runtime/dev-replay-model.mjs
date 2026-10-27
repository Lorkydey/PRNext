// Browser-safe scenario format. A recording contains intentions, never form values.
export const replayLimits = Object.freeze({maxSteps:50,maxScenarios:50,maxScenarioBytes:65536,maxLibraryBytes:128*1024,maxResultBytes:400*1024,maxResults:100,maxResultsPerScenario:3,maxScreenshotBytes:128*1024,timeoutMs:30000});
const schemaObject=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const schemaString=maxLength=>({type:'string',maxLength});
const targetSchema={oneOf:[
  schemaObject({kind:{const:'role'},role:{type:'string',pattern:'^[a-z][a-z0-9-]*$',maxLength:50},name:schemaString(500)}),
  ...['label','testId','text','css'].map(kind=>schemaObject({kind:{const:kind},value:schemaString(kind==='css'?1000:500)})),
]};
const pathnameSchema={type:'string',maxLength:1024,description:'Local application pathname only, without a host, query or fragment; no /_prnext routes.'};
/** Discoverable MCP input contract; validateReplay remains the authoritative validator. */
export const replayScenarioSchema=schemaObject({
  version:{const:1},id:{type:'string',format:'uuid',description:'Omit to create; use an existing scenario ID to update.'},name:schemaString(120),
  viewport:schemaObject({width:{type:'integer',minimum:240,maximum:2560},height:{type:'integer',minimum:240,maximum:2560}}),
  steps:{type:'array',minItems:2,maxItems:replayLimits.maxSteps,description:'First step must be visit. Include at least one expectVisible, expectText or expectURL assertion.',items:{oneOf:[
    ...['visit','expectURL'].map(type=>schemaObject({type:{const:type},path:pathnameSchema})),
    ...['click','expectVisible'].map(type=>schemaObject({type:{const:type},target:targetSchema})),
    schemaObject({type:{const:'fill'},target:targetSchema,parameter:{type:'string',pattern:'^[a-zA-Z][a-zA-Z0-9_]{0,63}$',description:'Named transient test fixture, never the typed value.'}}),
    schemaObject({type:{const:'expectText'},target:targetSchema,text:schemaString(2000)}),
  ]}},
},['version','name','viewport','steps']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function object(value,keys,label){
  if(!plain(value))throw Error(label+' must be an object.');
  for(const key of Object.keys(value))if(!keys.includes(key))throw Error('Unknown '+label+' field: '+key);
}
function string(value,max,label,{empty=false,multiline=false}={}){
  if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/:/[\u0000-\u001f\u007f]/).test(value))throw Error('Invalid '+label+'.');
  return value;
}
export function replayId(value){
  if(typeof value!=='string'||!/^\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b$/i.test(value))throw Error('Invalid replay identifier.');
  return value.toLowerCase();
}
export function replayPath(value){
  string(value,1024,'local pathname');
  if(!value.startsWith('/')||value.startsWith('//')||/[\\?#]/.test(value)||/%(?:00|0[ad]|2f|5c)/i.test(value))throw Error('Use a local pathname without a query, fragment or host.');
  const url=new URL(value,'http://prnext.local');
  let decoded;try{decoded=decodeURIComponent(url.pathname);}catch{throw Error('Invalid local pathname encoding.');}
  if(url.origin!=='http://prnext.local'||/^\/_prnext(?:\/|$)/.test(decoded))throw Error('Replay visits must target an application page.');
  return url.pathname;
}
export function validateReplayTarget(value){
  object(value,['kind','role','name','value'],'target');
  if(value.kind==='role'){
    object(value,['kind','role','name'],'role target');
    const role=string(value.role,50,'role');if(!/^[a-z][a-z0-9-]*$/.test(role))throw Error('Invalid role.');
    return {kind:'role',role,name:string(value.name,500,'accessible name')};
  }
  if(!['label','testId','text','css'].includes(value.kind))throw Error('Invalid target kind.');
  object(value,['kind','value'],'target');
  const target=string(value.value,value.kind==='css'?1000:500,'target value');
  // Playwright selector engines can pierce frames or change matching semantics.
  // CSS recordings use CSS only, with no engine chaining or pseudo text matching.
  if(value.kind==='css'&&(/>>|^[a-z][a-z0-9_:-]*=|:(?:has-text|text|text-is|text-matches|nth-match)\s*\(/i.test(target)))throw Error('Use a plain CSS selector.');
  return {kind:value.kind,value:target};
}
export function validateReplay(value){
  object(value,['version','id','name','viewport','steps'],'scenario');
  if(value.version!==1)throw Error('Unsupported replay version.');
  const scenario={version:1};if(value.id!==undefined)scenario.id=replayId(value.id);
  scenario.name=string(value.name,120,'scenario name').trim();
  object(value.viewport,['width','height'],'viewport');
  for(const key of ['width','height'])if(!Number.isSafeInteger(value.viewport[key])||value.viewport[key]<240||value.viewport[key]>2560)throw Error('Viewport '+key+' must be between 240 and 2560.');
  scenario.viewport={width:value.viewport.width,height:value.viewport.height};
  if(!Array.isArray(value.steps)||value.steps.length<2||value.steps.length>replayLimits.maxSteps)throw Error('A replay needs 2 to '+replayLimits.maxSteps+' steps.');
  let assertions=0;
  scenario.steps=value.steps.map(step=>{
    object(step,['type','path','target','parameter','text'],'step');
    if(step.type==='visit'||step.type==='expectURL'){
      object(step,['type','path'],'step');if(step.type==='expectURL')assertions++;
      return {type:step.type,path:replayPath(step.path)};
    }
    if(!['click','fill','expectVisible','expectText'].includes(step.type))throw Error('Unsupported replay step.');
    object(step,step.type==='fill'?['type','target','parameter']:step.type==='expectText'?['type','target','text']:['type','target'],'step');
    const result={type:step.type,target:validateReplayTarget(step.target)};
    if(step.type==='fill'){
      result.parameter=string(step.parameter,64,'fixture parameter');
      if(!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(result.parameter))throw Error('Fixture parameters must be simple names.');
    }
    if(step.type==='expectText')result.text=string(step.text,2000,'expected text',{empty:true,multiline:true});
    if(step.type.startsWith('expect'))assertions++;
    return result;
  });
  if(scenario.steps[0].type!=='visit')throw Error('The first replay step must visit a local page.');
  if(!assertions)throw Error('Add at least one visible, text or URL expectation.');
  if(new TextEncoder().encode(JSON.stringify(scenario)).length>replayLimits.maxScenarioBytes)throw Error('Replay scenario is too large.');
  return scenario;
}
export function replayParameters(scenario){return [...new Set(validateReplay(scenario).steps.filter(step=>step.type==='fill').map(step=>step.parameter))];}
// Kept self-contained so both the local runner and exported tests use the same
// viewport and hit-test expectation. It deliberately never scrolls the target.
export function replayOnScreen(element){
  const rectangle=element.getBoundingClientRect(),view=element.ownerDocument.defaultView;
  if(!view||rectangle.width<=0||rectangle.height<=0||rectangle.top<0||rectangle.left<0||rectangle.bottom>view.innerHeight||rectangle.right>view.innerWidth)return false;
  for(let ancestor=element;ancestor;ancestor=ancestor.parentElement){const style=view.getComputedStyle(ancestor);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;}
  const x=rectangle.left+rectangle.width/2,y=rectangle.top+rectangle.height/2,hit=element.ownerDocument.elementFromPoint(x,y);
  return !!hit&&(hit===element||element.contains(hit));
}
function locatorCode(target){
  const literal=JSON.stringify;
  if(target.kind==='role')return 'page.getByRole('+literal(target.role)+', { name: '+literal(target.name)+', exact: true })';
  if(target.kind==='label')return 'page.getByLabel('+literal(target.value)+', { exact: true })';
  if(target.kind==='testId')return 'page.getByTestId('+literal(target.value)+')';
  if(target.kind==='text')return 'page.getByText('+literal(target.value)+', { exact: true })';
  return 'page.locator('+literal(target.value)+')';
}
export function exportReplay(value){
  const scenario=validateReplay(value),literal=JSON.stringify;
  const lines=["import { test, expect } from '@playwright/test';",'', '// Set PRNEXT_REPLAY_BASE_URL and the named fixture environment variables below.',
    "const base = new URL(process.env.PRNEXT_REPLAY_BASE_URL || 'http://127.0.0.1:3000');",
    "if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('Replay requires a loopback application URL.');",
    'test.use({ viewport: '+literal(scenario.viewport)+", serviceWorkers: 'block', acceptDownloads: false });",'',
    'test('+literal(scenario.name)+', async ({ page, context }) => {',
    '  test.setTimeout(30000);',
    '  const errors = [];',
    '  const onScreen = '+replayOnScreen.toString()+';',
    "  page.on('pageerror', () => errors.push('Browser runtime error'));",
    "  page.on('console', message => { if (message.type() === 'error') errors.push('Browser console error'); });",
    "  context.on('page', popup => { if (popup !== page) { errors.push('Unexpected popup'); void popup.close(); } });",
    "  page.on('download', download => { errors.push('Unexpected download'); void download.cancel(); });",
    "  await context.addInitScript(() => { globalThis.__PRNEXT_REPLAY__ = true; });",
    "  await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === base.origin && ['http:', 'https:'].includes(url.protocol)) return route.continue(); errors.push('Blocked external request'); return route.abort('blockedbyclient'); });",
    "  await context.routeWebSocket('**/*', socket => { const url = new URL(socket.url()); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'; if (url.origin === base.origin) socket.connectToServer(); else { errors.push('Blocked external socket'); socket.close(); } });"];
  const parameters=replayParameters(scenario),fixtures=new Map(parameters.map((name,index)=>[name,'fixture'+index]));
  for(const parameter of parameters){const env='PRNEXT_REPLAY_'+parameter,variable=fixtures.get(parameter);lines.push('  const '+variable+' = process.env['+literal(env)+'];','  if ('+variable+" === undefined) throw new Error("+literal('Set fixture environment variable '+env)+');');}
  scenario.steps.forEach((step,index)=>{
    if(step.type==='visit'){lines.push('  '+(index?'if (new URL(page.url()).origin !== base.origin || new URL(page.url()).pathname !== '+literal(step.path)+') ':'')+'await page.goto(new URL('+literal(step.path)+", base).href, { waitUntil: 'domcontentloaded' });");return;}
    if(step.type==='expectURL'){lines.push('  await expect(page).toHaveURL(url => url.origin === base.origin && url.pathname === '+literal(step.path)+');');return;}
    const locator=locatorCode(step.target),name='target'+index;
    lines.push('  const '+name+' = '+locator+';', '  await expect('+name+').toHaveCount(1);');
    if(step.type==='click')lines.push('  await '+name+'.click();');
    if(step.type==='fill')lines.push('  await '+name+'.fill('+fixtures.get(step.parameter)+');');
    if(step.type==='expectVisible')lines.push('  await expect.poll(() => '+name+'.evaluate(onScreen)).toBe(true);');
    if(step.type==='expectText')lines.push('  await expect('+name+').toHaveText('+literal(step.text)+', { useInnerText: true });');
  });
  lines.push('  expect(new URL(page.url()).origin).toBe(base.origin);','  expect(errors).toEqual([]);','});','');
  return lines.join('\n');
}
