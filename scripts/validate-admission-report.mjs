import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';

const dir=path.resolve('reports/admission-ppr');
const browser=await chromium.launch();
const errors=[];
try {
  const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(pathToFileURL(path.join(dir,'performance.html')).href);
  const options=page.locator('#scenario option');
  assert.equal(await options.count(),14);
  for(let i=0;i<14;i++) {
    await page.selectOption('#scenario',String(i));
    assert.equal(await page.locator('#charts article').count(),4);
    assert.equal(await page.locator('#charts .track i').count(),12);
    const widths=await page.locator('#charts .track i').evaluateAll(nodes=>nodes.map(node=>Number.parseFloat(node.style.width)));
    assert.ok(widths.every(x=>Number.isFinite(x)&&x>=0&&x<=100.000001));
  }
  await page.selectOption('#scenario',await options.evaluateAll(nodes=>nodes.find(node=>node.textContent.includes('C512')&&!node.textContent.includes('45 s')).value));
  await page.screenshot({path:path.join(dir,'overview.png')});
  await page.locator('#charts').screenshot({path:path.join(dir,'comparison.png')});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.scrollTo(0,0));
  const mobile=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));
  assert.ok(mobile.width<=mobile.viewport+1,JSON.stringify(mobile));
  await page.screenshot({path:path.join(dir,'mobile.png')});
  assert.deepEqual(errors,[]);
  const result={passed:true,scenarios:14,chartsPerScenario:4,barsPerScenario:12,javascriptErrors:errors,mobile};
  await writeFile(path.join(dir,'ui-validation.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
