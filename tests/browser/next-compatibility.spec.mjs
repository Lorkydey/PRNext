import {test,expect} from '@playwright/test';
import {nextCompatibilityFixture} from '../next-compatibility-fixture.mjs';
import {startServer} from '../support.mjs';
let fixture,server;
test.beforeAll(async()=>{fixture=await nextCompatibilityFixture();await fixture.build();server=await startServer(fixture.root)});
test.afterAll(async()=>{await server?.close();await fixture?.remove()});
function errors(page){const found=[];page.on('pageerror',error=>found.push(error.message));page.on('console',m=>{if(m.type()==='error')found.push(m.text())});return found}
async function ready(page,url='/'){await page.goto(server.url+url);await page.waitForFunction(()=>window.__hydrated);}
test('client instrumentation runs in order before hydration and observes real navigation',async({page})=>{
  const found=errors(page);await ready(page);expect((await page.evaluate(()=>window.__clientHooks)).slice(0,3)).toEqual(['injected','application','hydrated']);
  await page.getByRole('link',{name:'Destination'}).click();await expect(page.getByRole('heading',{name:'Destination arrived'})).toBeVisible();
  expect(await page.evaluate(()=>window.__transitions.filter(t=>t.url==='/destination'))).toEqual([{source:'injected',url:'/destination',type:'push'},{source:'application',url:'/destination',type:'push'}]);expect(found).toEqual([]);
});
test('link status remains pending until commit and resets on supersession',async({page})=>{
  const found=errors(page);await ready(page);await page.getByRole('link',{name:'Destination'}).click();await expect(page.getByTestId('link-status')).toHaveText('pending');
  await page.getByRole('button',{name:'Supersede',exact:true}).click();await expect(page.getByRole('heading',{name:'Other arrived'})).toBeVisible();await expect(page.getByTestId('link-status')).toHaveText('idle');expect(found).toEqual([]);
});
test('an older queued mutation cannot finish a newer link status',async({page})=>{
  const found=errors(page);await ready(page);let held=false,release;const gate=new Promise(resolve=>release=resolve);
  await page.route('**/*',async route=>{if(route.request().headers()['next-action']&&!held){held=true;await gate}await route.continue()});
  try{await page.getByRole('button',{name:'Queue mutations',exact:true}).click();await expect.poll(()=>held).toBe(true);await page.getByRole('link',{name:'Destination'}).click();await expect(page.getByTestId('link-status')).toHaveText('pending');release();await page.waitForFunction(()=>window.__queuedFinished);await expect(page.getByTestId('link-status')).toHaveText('pending');await expect(page.getByRole('heading',{name:'Destination arrived'})).toBeVisible();await expect(page.getByTestId('link-status')).toHaveText('idle');expect(found).toEqual([])}finally{release()}
});
test('GET Form retains successful controls, duplicate keys and keyboard submission',async({page})=>{
  const found=errors(page);await ready(page);const input=page.getByLabel('Search',{exact:true});await input.fill('two words & punctuation');await input.press('Enter');await expect(page).toHaveURL(/\/search\?/);
  const url=new URL(page.url());expect(url.searchParams.get('q')).toBe('two words & punctuation');expect(url.searchParams.getAll('tag')).toEqual(['one','two']);expect(url.searchParams.has('discard')).toBe(false);expect(found).toEqual([]);
});
test('native validation and submitter destinations remain effective',async({page})=>{
  const found=errors(page);await ready(page);await page.getByLabel('Search',{exact:true}).fill('');await page.getByRole('button',{name:'Search now',exact:true}).click();expect(new URL(page.url()).pathname).toBe('/');
  await page.getByLabel('Search',{exact:true}).fill('valid');await page.getByRole('button',{name:'Other submit',exact:true}).click();await expect(page).toHaveURL(/\/other\?/);expect(new URL(page.url()).searchParams.get('alternate')).toBe('yes');expect(found).toEqual([]);
});
test('function Form actions preserve React execution and reset semantics',async({page})=>{
  const found=errors(page);await ready(page);await page.getByRole('button',{name:'Client action',exact:true}).click();await expect(page.getByRole('button',{name:'Ready 9',exact:true})).toBeVisible();expect(found).toEqual([]);
});
test('Form progressively enhances a Server Action with useActionState',async({page})=>{
  const found=errors(page);await ready(page);await page.evaluate(()=>window.__sameDocument=true);await page.getByLabel('Server value').fill('browser');await page.getByRole('button',{name:'Server submit',exact:true}).click();await expect(page.getByTestId('server-action-state')).toHaveText('saved browser');expect(await page.evaluate(()=>window.__sameDocument)).toBe(true);expect((await page.context().cookies()).find(x=>x.name==='compat-form')?.value).toBe('browser');expect(found).toEqual([]);
});
test('Form Server Actions work with JavaScript disabled',async({browser})=>{
  const context=await browser.newContext({javaScriptEnabled:false});try{const page=await context.newPage();await page.goto(server.url);await page.getByLabel('Server value').fill('native-value');await page.getByRole('button',{name:'Server submit',exact:true}).click();await expect(page.getByTestId('server-action-state')).toHaveText('saved native-value');expect((await context.cookies()).find(x=>x.name==='compat-form')?.value).toBe('native-value')}finally{await context.close()}
});
test('Pages Form performs client navigation while keeping native query semantics',async({page})=>{
  const found=errors(page);await page.goto(server.url+'/legacy-form');await page.getByLabel('Legacy search').fill('from pages');await page.getByRole('button',{name:'Legacy submit',exact:true}).click();await expect(page.getByRole('heading',{name:'Legacy from pages'})).toBeVisible();expect(found).toEqual([]);
});
test('SSR inserted styles and scoped styled-jsx remain valid after hydration',async({page,request})=>{
  const found=errors(page),response=await request.get(server.url+'/');const html=await response.text();expect(html).toContain('data-inserted="yes"');expect(html).toContain('data-private="yes"');expect(html).toContain('.scoped.jsx-');await ready(page);
  await expect(page.getByText('Inserted CSS',{exact:true})).toHaveCSS('color','rgb(10, 20, 30)');await expect(page.getByText('Scoped CSS',{exact:true})).toHaveCSS('color','rgb(30, 40, 50)');expect(found).toEqual([]);
  await expect(page.getByText('Styled components CSS',{exact:true})).toHaveCSS('color','rgb(60, 70, 80)');await expect(page.getByText('Emotion CSS',{exact:true})).toHaveCSS('color','rgb(90, 100, 110)');expect(found).toEqual([]);
  await page.goto(server.url+'/legacy-form');await expect(page.getByText('Pages styled JSX',{exact:true})).toHaveCSS('color','rgb(120, 130, 140)');expect(found).toEqual([]);
  await expect(page.getByText('Pages styled components',{exact:true})).toHaveCSS('color','rgb(150, 160, 170)');expect(found).toEqual([]);
});
test('Web Vitals reports real browser metrics through the public hook',async({page})=>{
  const found=errors(page);await ready(page);await page.waitForFunction(()=>window.__vitals?.some(m=>m.name==='FCP')&&window.__vitals.some(m=>m.name==='TTFB'));
  expect(await page.evaluate(()=>window.__vitals.every(m=>typeof m.id==='string'&&Number.isFinite(m.value)&&m.value>=0))).toBe(true);expect(found).toEqual([]);
});
