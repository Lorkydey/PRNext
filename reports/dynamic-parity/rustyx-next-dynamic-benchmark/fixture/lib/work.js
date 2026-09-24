import {appendFileSync} from 'node:fs';
import {unstable_cache} from 'next/cache';
export function audit(kind,input={}){if(!process.env.BENCH_AUDIT_FILE)throw new Error('BENCH_AUDIT_FILE is required');appendFileSync(process.env.BENCH_AUDIT_FILE,JSON.stringify({kind,input,pid:process.pid})+'\n');}
export const catalogue=Array.from({length:32},(_,i)=>({sku:'sku-'+i,label:'Item '+i,priceCents:1000+i,available:i%2===0}));
export function compute(){let value=0;for(let i=0;i<1000;i++)value=(value+i*17)%100003;return value;}
export async function readData(key,tenant='public',delay=0){const u=new URL('/data',process.env.BENCH_BACKEND_URL);u.searchParams.set('key',key);u.searchParams.set('tenant',tenant);u.searchParams.set('delay',String(delay));const r=await fetch(u,{cache:'no-store'});if(!r.ok)throw new Error('backend '+r.status);return r.json();}
export function cachedData(key){return unstable_cache(async()=>{audit('cache-fill',{key});return readData(key)},['dynamic-parity-v1',key],{tags:['product:'+key],revalidate:false})();}
export async function mutateData(key,delta){const r=await fetch(new URL('/data',process.env.BENCH_BACKEND_URL),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,delta}),cache:'no-store'});if(!r.ok)throw new Error('backend mutation '+r.status);return r.json();}
