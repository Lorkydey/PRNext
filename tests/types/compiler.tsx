import type {NextConfig} from '@thomas.f/prnext';
export const config: NextConfig = {onDemandEntries:{maxInactiveAge:3600000,pagesBufferLength:5},turbopack:{root:process.cwd(),rules:{'*.svg':[
  {loaders:['@svgr/webpack'],as:'*.js',condition:{all:[{not:'foreign'},'browser',{path:'images/*.svg',content:/<svg/}]}},
  {loaders:['server-loader'],condition:{any:['node','edge-light']}},
]}}};
