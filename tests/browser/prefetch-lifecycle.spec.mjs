import {test,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {partialFixture} from '../partial-fixture.mjs';
import {startServer} from '../support.mjs';

test('leaving an App document while consuming a held prefetch never starts a replacement Flight request',async({page})=>{
  const fixture=await partialFixture();let server,release;
  const gate=new Promise(resolve=>{release=resolve;}),requests=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try {
    await mkdir(path.join(fixture.root,'app/lifecycle'));
    await writeFile(path.join(fixture.root,'app/lifecycle/page.jsx'),`import {randomUUID} from 'node:crypto';import Client from './Client';export const dynamic='force-dynamic';export default function Page(){return <Client revision={randomUUID()}/>} `);
    await writeFile(path.join(fixture.root,'app/lifecycle/Client.jsx'),`'use client';import {useEffect} from 'react';import {useRouter} from 'next/navigation';export default function Client({revision}){const router=useRouter();useEffect(()=>{window.__lifecycleRouter=router;window.__lifecycleRevision=revision},[router,revision]);return <h1>Lifecycle home</h1>}`);
    await fixture.build();server=await startServer(fixture.root);
    page.on('request',request=>{if(new URL(request.url()).pathname==='/product/cancelled')requests.push(request.headers());});
    await page.route('**/product/cancelled',async route=>{
      await gate;
      await route.abort().catch(()=>{});
    });
    await page.goto(server.url+'/lifecycle');
    await page.waitForFunction(()=>Boolean(window.__lifecycleRouter));
    await page.evaluate(()=>{
      window.__capacityInvalidations=0;
      const warm=index=>window.__lifecycleRouter.prefetch('/product/capacity-'+index,{onInvalidate:()=>{
        window.__capacityInvalidations++;
        if(window.__capacityInvalidations<20)warm(index);
      }});
      for(let index=0;index<9;index++)warm(index);
    });
    await page.waitForTimeout(250);
    expect(await page.evaluate(()=>window.__capacityInvalidations)).toBe(1,'self-rearming callbacks cannot form an eviction loop beyond the eight-entry cache');
    const previousRevision=await page.evaluate(()=>window.__lifecycleRevision);
    const refreshResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/lifecycle'&&response.request().headers().rsc==='1');
    const synchronousInvalidations=await page.evaluate(()=>{
      window.__lifecycleInvalidations=0;
      const warm=()=>{
        window.__lifecycleInvalidations++;
        // Bound the regression itself: the previous live-Map iteration would
        // repeatedly invalidate a newly rearmed callback in the same turn.
        if(window.__lifecycleInvalidations<4)window.__lifecycleRouter.prefetch('/product/rearm',{onInvalidate:warm});
      };
      window.__lifecycleRouter.prefetch('/product/rearm',{onInvalidate:warm});
      window.__lifecycleRouter.refresh();
      return window.__lifecycleInvalidations;
    });
    expect(synchronousInvalidations).toBeLessThanOrEqual(1);
    await refreshResponse;
    // HTTP completion precedes the router's final invalidation/React commit.
    // Begin the independent cancellation scenario only after refresh applied.
    await page.waitForFunction(previous=>window.__lifecycleRevision!==previous,previousRevision);
    await expect.poll(()=>page.evaluate(()=>window.__lifecycleInvalidations)).toBeGreaterThan(0);
    await page.evaluate(()=>window.__lifecycleRouter.prefetch('/product/cancelled'));
    await expect.poll(()=>requests.length).toBe(1);
    expect(requests[0]['x-prnext-prefetch']).toBe('1');
    await page.evaluate(()=>{
      window.__lifecycleRouter.push('/product/cancelled');
      window.dispatchEvent(new Event('pagehide'));
    });
    // Cancellation is asynchronous; allow the rejected producer and any buggy
    // retry path to settle before asserting the absence of replacement traffic.
    await page.waitForTimeout(300);
    expect(requests.length).toBe(1);
    await expect(page).toHaveURL(server.url+'/lifecycle');
    await expect(page.getByRole('heading',{name:'Lifecycle home',exact:true})).toBeVisible();
    expect(errors).toEqual([]);
  } finally {release();await server?.close();await fixture.remove();}
});
