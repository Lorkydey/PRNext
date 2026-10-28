import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHtmlOnlyGraph } from './html-only-graph.mjs';

test('HTML-only validation follows transitive client/action dependencies but ignores unrelated application routes', () => {
  const graph=createHtmlOnlyGraph(process.cwd());
  graph.source('client.jsx',`'use client';export default ()=>null`);
  graph.source('actions.js',`export async function save(){'use server';return 1}`);
  graph.record({inputs:{'page.jsx':{imports:[{path:'helper.js'}]},'helper.js':{imports:[{path:'client.jsx'}]},'safe.jsx':{imports:[]}}});
  assert.throws(()=>graph.validate({pattern:'/bad',file:path.resolve('page.jsx')}),/Client Component.*client.jsx/);
  assert.throws(()=>graph.validate({pattern:'/action',file:path.resolve('actions.js')}),/Server Action/);
  graph.validate({pattern:'/safe',file:path.resolve('safe.jsx')});
});

test('HTML-only rejects framework interactivity, scripts, event props and opaque imports before rendering', () => {
  for(const source of [`import Link from 'next/link';export default ()=> <Link href="/">Home</Link>`,`export default ()=> <script>bad()</script>`,`export default ()=> <button onClick={()=>{}}>Click</button>`,`const value=import(process.env.NAME)`,`const value=require(process.env.NAME)`]) {
    const graph=createHtmlOnlyGraph(process.cwd());graph.source('page.jsx',source);assert.throws(()=>graph.validate({pattern:'/',file:path.resolve('page.jsx')}),/htmlOnly/);
  }
  const graph=createHtmlOnlyGraph(process.cwd());graph.record({inputs:{'page.jsx':{imports:[{path:'native-package',external:true}]}}});assert.throws(()=>graph.validate({pattern:'/',file:path.resolve('page.jsx')}),/unverified external/);
});
