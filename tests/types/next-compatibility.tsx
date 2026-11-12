import Form from 'next/form';
import Link,{useLinkStatus} from 'next/link';
import {useServerInsertedHTML} from 'next/navigation';
import {useReportWebVitals} from 'next/web-vitals';
import type {DeploymentAdapter,NextConfig} from '@thomas.f/prnext';
export function Compatibility(){
  const {pending}=useLinkStatus();
  useReportWebVitals(metric=>{const value:number=metric.value;const id:string=metric.id;void value;void id});
  useServerInsertedHTML(()=> <style>{'p{color:red}'}</style>);
  return <><Link href='/test'>{pending?'Loading':'Continue'}</Link><Form action='/search' replace scroll={false} prefetch={false}><input name='q'/><button>Search</button></Form><Form action={async(data:FormData)=>{void data.get('q')}}><button>Save</button></Form></>;
}
const config:NextConfig={adapterPath:'./adapter.ts',compiler:{styledComponents:{ssr:true},emotion:{autoLabel:'always'},removeConsole:{exclude:['error']},define:{FLAG:true},defineServer:{SERVER_ONLY:'value'},styledJsx:{useLightningcss:true},relay:{src:'src',language:'typescript'},async runAfterProductionCompile({projectDir,distDir}){void projectDir;void distDir}}};
const adapter:DeploymentAdapter={name:'typed-adapter',prnextAdapterVersion:1,modifyConfig(config,ctx){const framework:'prnext'=ctx.framework;void framework;return config},onBuildComplete(ctx){const outputVersion:1=ctx.output.version;void outputVersion}};
void config;void adapter;
