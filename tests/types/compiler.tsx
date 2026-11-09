import type {NextConfig} from '@thomas.f/prnext';
import type {ReactCompilerOptions,BuildResult,ReactCompilerReport,PresentationReport} from '@thomas.f/prnext';
const presentationDiagnostics:PresentationReport={version:1,templates:1,components:[{
  file:'app/page.tsx',status:'partial',blocks:1,staticBlocks:[{elements:70,htmlBytes:2000,offset:42}],
},{file:'app/Table.tsx',status:'compact',templateId:'client-presentation-example',sharedSources:2,fused:true,ssr:true,dom:true,packet:'adaptive-flat-binary'}]};
function compilerResult(result:BuildResult){
  const report:ReactCompilerReport|undefined=result.reactCompilerReport;
  if(report?.enabled)return report.files.flatMap(file=>file.functions.map(fn=>({file:file.file,name:fn.name,status:fn.status})));
  return [];
}
const automatic: NextConfig = {reactCompiler: true};
const disabled: NextConfig = {reactCompiler: false};
const automaticPresentation: NextConfig = {presentationComponents: true};
const ordinaryPresentation: NextConfig = {presentationComponents: false};
// @ts-expect-error automatic presentation has a boolean global opt-out
const invalidAutomaticPresentation: NextConfig = {presentationComponents: 'auto'};
const compilerOptions: ReactCompilerOptions = {compilationMode: 'annotation', panicThreshold: 'none', target: '19'};
const annotated: NextConfig = {reactCompiler: compilerOptions};
const nativeCompiler: NextConfig = {reactCompiler: {backend: 'oxc', target: '19'}};
const experiments: NextConfig = {cacheComponents: true, experimental: {
  nativePprShell: true, streamingRequestBodies: true,
  presentationComponents: true,
  parallelBuilds: {maxWorkers: 4, maxMemoryMb: 1024},
}};
// @ts-expect-error the compact presentation feature requires an explicit boolean
const invalidPresentation: NextConfig = {experimental: {presentationComponents: 'automatic'}};
// @ts-expect-error Unknown native compiler backends are rejected.
const invalidBackend: NextConfig = {reactCompiler: {backend: 'native'}};
// @ts-expect-error Streaming request bodies are an explicit boolean option.
const invalidStreaming: NextConfig = {experimental: {streamingRequestBodies: 'auto'}};
// @ts-expect-error Only supported React Compiler compilation modes are accepted.
const invalidMode: NextConfig = {reactCompiler: {compilationMode: 'all'}};
// @ts-expect-error This framework requires matching React 19 peers.
const invalidTarget: NextConfig = {reactCompiler: {target: '18'}};
// @ts-expect-error Unknown compiler options must not silently change behavior.
const invalidOption: NextConfig = {reactCompiler: {enabled: true}};
export const config: NextConfig = {onDemandEntries:{maxInactiveAge:3600000,pagesBufferLength:5},turbopack:{root:process.cwd(),rules:{'*.svg':[
  {loaders:['@svgr/webpack'],as:'*.js',condition:{all:[{not:'foreign'},'browser',{path:'images/*.svg',content:/<svg/}]}},
  {loaders:['server-loader'],condition:{any:['node','edge-light']}},
]}}};
