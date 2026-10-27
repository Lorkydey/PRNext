import type {NextConfig} from '@thomas.f/prnext';
import type {ReactCompilerOptions} from '@thomas.f/prnext';
const automatic: NextConfig = {reactCompiler: true};
const disabled: NextConfig = {reactCompiler: false};
const compilerOptions: ReactCompilerOptions = {compilationMode: 'annotation', panicThreshold: 'none', target: '19'};
const annotated: NextConfig = {reactCompiler: compilerOptions};
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
