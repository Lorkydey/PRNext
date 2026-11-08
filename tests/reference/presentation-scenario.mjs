import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {expect} from '@playwright/test';

// Test-only additions to the disposable, authenticated PostgreSQL consumer.
// The display module intentionally has no directive, imports or config opt-in.
export const presentationScenarioFiles={
  'app/presentation-notes.jsx':`export default function NotesPresentation({rows}){return <section data-testid="presentation-notes"><table><tbody>{rows.map(row=><tr key={row.id}><td>{row.body}</td><td>{row.index+1}</td><td>{row.income-row.internalCost}</td><td>{row.flagValue?'Note':'Note'}</td></tr>)}</tbody></table></section>}`,
  'app/[locale]/presentation/page.jsx':`import{headers}from'next/headers';import{redirect}from'next/navigation';import Link from'next/link';import{desc,eq}from'drizzle-orm';import{getAuth}from'../../../lib/auth.js';import{getDatabase,notes}from'../../../lib/database.js';import NotesPresentation from'../../presentation-notes';export default async function Page({params}){const{locale}=await params;const session=await getAuth().api.getSession({headers:await headers()});if(!session)redirect('/'+locale+'/sign-in');const items=await getDatabase().select().from(notes).where(eq(notes.userId,session.user.id)).orderBy(desc(notes.createdAt)).limit(100);const rows=items.map((note,index)=>({...note,index,income:987654321,internalCost:987654320,flagValue:true,privateMeta:'NEVER_TRANSFER_PRESENTATION_'+session.user.id}));return <main><h1>Presentation notes</h1><p data-testid="presentation-owner">{session.user.email}</p><NotesPresentation rows={rows}/><Link href={'/'+locale+'/dashboard'} prefetch={false}>Back to dashboard</Link></main>}`,
};

export function createPresentationSoakScenario({repositoryRoot}){
  const report={directiveRequired:false,configurationRequired:false,application:'Authenticated PostgreSQL notes with ordinary React display component',sourceFiles:{},eligible:false,reads:0,compactReads:0,ordinaryReads:0,browserVisits:0,maximumRows:0};
  return {report,files:presentationScenarioFiles,
    async verifyBuild(fixture){
      const eligibility=JSON.parse(await readFile(path.join(fixture.root,'.prnext/presentation-report.json'),'utf8'));
      const entry=eligibility.components.find(item=>item.file==='app/presentation-notes.jsx');
      assert.ok(entry&&['compact','fallback'].includes(entry.status));
      if(entry.status==='fallback'){assert.ok(entry.reason);report.fallbackReason=entry.reason;}
      for(const name of ['build/presentation-auto.mjs','build/presentation.mjs','runtime/presentation.mjs']){
        const installed=await readFile(path.join(path.dirname(fixture.cli),name)),source=await readFile(path.join(repositoryRoot,'packages/prnext',name));
        assert.deepEqual(installed,source);report.sourceFiles[name]=createHash('sha256').update(installed).digest('hex');
      }
      report.eligible=entry.status==='compact';
    },
    async probe({user,users,fixture,marker}){
      const other=users.find(value=>value!==user),url=fixture.origin+'/en/presentation';
      const response=await user.context.request.get(url,{headers:{RSC:'1'},timeout:15000});
      assert.equal(response.status(),200);assert.match(response.headers()['content-type'],/text\/x-component/);
      const body=await response.text();
      assert.ok(body.includes(user.email)&&body.includes(marker));
      assert.ok(!body.includes(other.email)&&!body.includes('SOAK_'+other.userId+'_'));
      for(const forbidden of ['NEVER_TRANSFER_PRESENTATION_','987654321','987654320'])assert.ok(!body.includes(forbidden),'Private presentation inputs must remain server-side');
      report.reads++;if(body.includes('__prnextPresentation'))report.compactReads++;else report.ordinaryReads++;
      await user.page.goto(url);
      await expect(user.page.getByTestId('presentation-owner')).toHaveText(user.email);
      await expect(user.page.getByTestId('presentation-notes')).toContainText(marker);
      await expect(user.page.getByTestId('presentation-notes')).not.toContainText('SOAK_'+other.userId+'_');
      const count=await user.page.locator('[data-testid="presentation-notes"] tbody tr').count();
      assert.ok(count>0&&count<=100);report.maximumRows=Math.max(report.maximumRows,count);report.browserVisits++;
      await user.page.getByRole('link',{name:'Back to dashboard',exact:true}).click();
      await expect(user.page.getByTestId('account')).toContainText(user.email);
    },
    finish(){
      if(report.eligible)assert.ok(report.compactReads>0,'An eligible sustained workload must actually use compact Flight');
      else{assert.equal(report.compactReads,0);assert.ok(report.fallbackReason,'Unverified custom pipelines must remain ordinary');}
      assert.ok(report.maximumRows>=32,'The real SQL workload must reach presentation-sized data');
      assert.equal(report.reads,report.browserVisits);
    },
  };
}
