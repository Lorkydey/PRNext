import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repositoryRoot } from './support.mjs';

export async function stylesFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-styles-'));
  try {
    await symlink(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    const files = {
      'package.json': JSON.stringify({ name: 'prnext-styles-fixture', type: 'module', private: true }),
      'prnext.config.mjs': `export default{basePath:'/docs',assetPrefix:'/resources',sassOptions:{additionalData:'$theme: rgb(12, 34, 56);'}}`,
      'postcss.config.mjs': `export default { plugins: { '@tailwindcss/postcss': {}, autoprefixer: {overrideBrowserslist:['Safari 8']} } };`,
      'styles/global.css': '@import "tailwindcss"; @source "../components"; .postcss-global { user-select: none; }',
      'styles/global.scss': '.sass-global { border-top: 3px solid $theme; }',
      'styles/partials/_visual.scss': '.assetMark { background-image: url("./dot.svg"); }',
      'styles/partials/dot.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3" fill="red"/></svg>',
      'styles/shared.module.scss': '.shared { letter-spacing: 1px; }',
      'styles/card.module.scss': '@use "./partials/visual"; .card { composes: shared from "./shared.module.scss"; color: $theme; } :export { primaryColor: $theme; }',
      'styles/indented.module.sass': '.indented\n  text-decoration-line: underline\n',
      'components/Probe.jsx': `'use client';import{useState}from'react';import Link from'next/link';import styles from'../styles/card.module.scss';import indented from'../styles/indented.module.sass';export default function Probe({router}){const[count,setCount]=useState(0);return <main className="sass-global"><h1 data-testid="styled" className={'p-4 font-bold postcss-global '+styles.card+' '+styles.assetMark+' '+indented.indented}>Styled {router}</h1><output data-testid="exported" style={{color:styles.primaryColor}}>{styles.primaryColor}</output><button data-testid="count" onClick={()=>setCount(count+1)}>Count {count}</button><Link data-testid="next" href={'/'+router+'/other'}>Other</Link></main>}`,
      'app/layout.jsx': `import '../styles/global.css';import '../styles/global.scss';export default function Layout({children}){return <html><body>{children}</body></html>}`,
      'app/app/page.jsx': `import Probe from'../../components/Probe';export default function Page(){return <Probe router="app"/>}`,
      'app/app/other/page.jsx': `import Probe from'../../../components/Probe';export default function Page(){return <Probe router="app"/>}`,
      'pages/_app.jsx': `import'../styles/global.css';import'../styles/global.scss';export default function App({Component,pageProps}){return <Component {...pageProps}/>} `,
      'pages/pages/index.jsx': `import Probe from'../../components/Probe';export default function Page(){return <Probe router="pages"/>}`,
      'pages/pages/other.jsx': `import Probe from'../../components/Probe';export default function Page(){return <Probe router="pages"/>}`,
    };
    for (const [name, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), content);
    }
    return { root, build: async ({ dev = false } = {}) => {
      await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', root, ...(dev ? ['--dev'] : [])], { maxBuffer: 8 * 1024 * 1024 });
      const outputDirectory = path.join(root, '.prnext');
      return { ...JSON.parse(await readFile(path.join(outputDirectory, 'manifest.json'), 'utf8')), outputDirectory };
    }, remove: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
