import {mkdir,writeFile,rm,symlink,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {appFixture,repositoryRoot} from './support.mjs';
export const ecosystemDirectory=fileURLToPath(new URL('./ecosystem/',import.meta.url));
export async function ecosystemFixture(){
  const fixture=await appFixture({temporaryRoot:path.join(repositoryRoot,'artifacts/ecosystem-fixtures')});
  try{
    for(const name of ['app','pages','components','proxy.ts','tsconfig.json','next-env.d.ts'])await rm(path.join(fixture.root,name),{recursive:true,force:true});
    const dependencies=JSON.parse(await readFile(path.join(ecosystemDirectory,'package.json'),'utf8')).dependencies;
    for(const name of Object.keys(dependencies)){
      await rm(path.join(fixture.root,'node_modules',name),{recursive:true,force:true});
      await mkdir(path.dirname(path.join(fixture.root,'node_modules',name)),{recursive:true});
      await symlink(path.join(ecosystemDirectory,'node_modules',name),path.join(fixture.root,'node_modules',name),'dir');
    }
    await writeFile(path.join(fixture.root,'package.json'),JSON.stringify({name:'prnext-real-ecosystem',private:true,type:'module',dependencies}));
    const files={
      'next.config.mjs':`import createNextIntlPlugin from 'next-intl/plugin';const withIntl=createNextIntlPlugin('./i18n/request.js');export default withIntl({webpack(config){config.module.rules.push({test:/\\.mdx$/,use:[{loader:'@mdx-js/loader'}]});return config;}})`,
      'i18n/request.js':`import{cookies}from'next/headers';import{getRequestConfig}from'next-intl/server';export default getRequestConfig(async()=>{const locale=(await cookies()).get('locale')?.value==='fr'?'fr':'en';return{locale,timeZone:'UTC',messages:{Home:{title:locale==='fr'?'Bonjour PRNext':'Hello PRNext',clicks:locale==='fr'?'Clics : {n}':'Clicks: {n}'}}}})`,
      'lib/auth.js':`import{betterAuth}from'better-auth';import{nextCookies}from'better-auth/next-js';import{DatabaseSync}from'node:sqlite';export const auth=betterAuth({secret:'prnext-ecosystem-fixture-only-not-a-production-secret',baseURL:{allowedHosts:['127.0.0.1:*'],protocol:'http'},database:new DatabaseSync('auth.sqlite'),emailAndPassword:{enabled:true},plugins:[nextCookies()],telemetry:{enabled:false}})`,
      'lib/db.js':`import{DatabaseSync}from'node:sqlite';import{drizzle}from'drizzle-orm/sqlite-proxy';import{sqliteTable,integer,text}from'drizzle-orm/sqlite-core';export const notes=sqliteTable('notes',{id:integer('id').primaryKey({autoIncrement:true}),body:text('body').notNull(),userId:text('user_id').notNull()});const sqlite=new DatabaseSync('notes.sqlite');sqlite.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL,user_id TEXT NOT NULL)');export const db=drizzle(async(sql,params,method)=>{const statement=sqlite.prepare(sql);if(method==='run'){statement.run(...params);return{rows:[]}}statement.setReturnArrays(true);return{rows:method==='get'?statement.get(...params):statement.all(...params)}})`,
      'app/api/auth/[...all]/route.js':`import{auth}from'../../../../lib/auth';import{toNextJsHandler}from'better-auth/next-js';export const{GET,POST}=toNextJsHandler(auth)`,
      'app/actions.js':`'use server';import{headers}from'next/headers';import{auth}from'../lib/auth';import{db,notes}from'../lib/db';export async function save(previous,form){const session=await auth.api.getSession({headers:await headers()});if(!session)throw new Error('Unauthorized');const body=String(form.get('body'));if(body.length>100)throw new Error('Too long');const result=await db.insert(notes).values({body,userId:session.user.id}).returning();return{id:result[0].id,body:result[0].body}}`,
      'app/client.jsx':`'use client';import{useState,useActionState}from'react';import{useTranslations}from'next-intl';import{save}from'./actions';export default function Client(){const t=useTranslations('Home'),[n,set]=useState(0),[value,action,pending]=useActionState(save,{});return <><button onClick={()=>set(n+1)}>{t('clicks',{n})}</button><form action={action}><input name='body' defaultValue='persisted through Drizzle'/><button disabled={pending}>Save note</button><output data-testid='saved'>{value.body}</output></form></>}`,
      'app/layout.jsx':`import{NextIntlClientProvider}from'next-intl';import{getLocale,getMessages}from'next-intl/server';export default async function Layout({children}){return <html><body><NextIntlClientProvider locale={await getLocale()} messages={await getMessages()} timeZone='UTC'>{children}</NextIntlClientProvider></body></html>}`,
      'app/page.jsx':`import{headers}from'next/headers';import{getTranslations}from'next-intl/server';import Link from'next/link';import{auth}from'../lib/auth';import Client from'./client';export async function generateMetadata(){return{title:(await getTranslations('Home'))('title')}}export default async function Home(){const t=await getTranslations('Home'),session=await auth.api.getSession({headers:await headers()});return <main><h1>{t('title')}</h1><p data-testid='session'>{session?.user.email||'anonymous'}</p><Client/><Link href='/notes'>Notes</Link><Link href='/guide'>Guide</Link></main>}`,
      'app/notes/page.jsx':`import{eq}from'drizzle-orm';import{db,notes}from'../../lib/db';import{headers}from'next/headers';import{auth}from'../../lib/auth';export default async function Notes(){const session=await auth.api.getSession({headers:await headers()});return <main><h1>Notes</h1>{session?(await db.select().from(notes).where(eq(notes.userId,session.user.id))).map(note=><p key={note.id}>{note.body}</p>):<p>Unauthorized</p>}</main>}`,
      'app/guide/page.jsx':`import Document from'./document.mdx';export default()=> <Document/>`,
      'app/guide/document.mdx':`# Compiled MDX guide\n\nThis content came through the real MDX webpack loader.\n\nexport const value = 7\n\n<strong data-testid="mdx-value">{value * 6}</strong>`,
      'app/after/page.jsx':`import{after}from'next/server';import{cookies,headers}from'next/headers';import{appendFile}from'node:fs/promises';export default async function Page(){const visitor=(await cookies()).get('visitor')?.value||'none';after(async()=>{let blocked=false;try{await headers()}catch{blocked=true}await appendFile('after.jsonl',JSON.stringify({visitor,blocked})+'\\n')});return <h1>After response {visitor}</h1>}`,
      'setup.mjs':`import{auth}from'./lib/auth.js';import{getMigrations}from'better-auth/db/migration';const migrations=await getMigrations(auth.options);await migrations.runMigrations();`,
    };
    for(const [name,source]of Object.entries(files)){const file=path.join(fixture.root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,source);}
    await promisify(execFile)(process.execPath,[path.join(fixture.root,'setup.mjs')],{cwd:fixture.root,maxBuffer:1024*1024});
    return fixture;
  }catch(error){await fixture.remove();throw error;}
}
