import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { devFixture } from './dev-fixture.mjs';
import { repositoryRoot, binary } from './support.mjs';

// Keep instrumentation outside the component being compiled. The imported
// calculation is deterministic; its ancillary call count lets the browser test
// observe actual memoization without putting impure instrumentation in render.
const computation = `export function calculate(kind, input) {
  if (typeof window !== 'undefined') {
    const calls = window.__reactCompilerCalls ||= {};
    calls[kind] = (calls[kind] || 0) + 1;
  }
  let result = 0;
  for (let value = 1; value <= input; value++) result += value;
  return result;
}`;

export function compilerDemoSource(label = 'Original') {
  const component = (name, kind, directive = '') => `function ${name}() {
    ${directive ? JSON.stringify(directive) + ';' : ''}
    const [count, setCount] = useState(0);
    const [input, setInput] = useState('200');
    const id = useId();
    const result = calculate('${kind}', Number(input));
    return <section data-testid="${kind}">
      <h2>${label} ${kind}</h2>
      <button data-testid="${kind}-count" onClick={() => setCount(count + 1)}>Count {count}</button>
      <label data-testid="${kind}-label" htmlFor={id}>${kind} calculation<input id={id} data-testid="${kind}-input" value={input} onChange={event => setInput(event.target.value)}/></label>
      <output data-testid="${kind}-result">{result}</output>
    </section>;
  }`;
  return `'use client';
import { useState, useId } from 'react';
import { calculate } from './calculation.js';
import { decoratedMtsValue } from './decorated-helper.mts';
import { decoratedCtsValue } from './decorated-helper.cts';
${component('Automatic', 'automatic')}
${component('Annotated', 'annotated', 'use memo')}
${component('OptOut', 'optout', 'use no memo')}
export default function CompilerDemo() {
  return <main><Automatic/><Annotated/><OptOut/><p data-testid="decorated-result">{decoratedMtsValue + decoratedCtsValue}</p></main>;
}
`;
}

export function compilerFixtureFiles() {
  return {
    'package.json': '{"name":"react-compiler-validation","type":"module","private":true}',
    'postcss.config.json': '{"plugins":[]}',
    'components/calculation.js': computation,
    'components/decorated-helper.mts': `function identity(value: any) {return value}
@identity class Configuration {value = 19}
export const decoratedMtsValue = new Configuration().value;`,
    'components/decorated-helper.cts': `function identity(value: any) {return value}
@identity class Configuration {value = 21}
module.exports = {decoratedCtsValue: new Configuration().value};`,
    'components/CompilerDemo.jsx': compilerDemoSource(),
    'pages/pages.jsx': `import CompilerDemo from '../components/CompilerDemo';
export const getServerSideProps = () => ({props:{message:'Pages server rendered'}});
export default function Page({message}) {return <><h1>{message}</h1><CompilerDemo/></>}`,
    'app/layout.jsx': 'export default function Layout({children}) {return <html><head/><body>{children}</body></html>}',
    'app/app/page.jsx': `import { cookies } from 'next/headers';
import CompilerDemo from '../../components/CompilerDemo';
import Action from './client';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const value = (await cookies()).get('react-compiler-action')?.value || 'not saved';
  return <><h1>App server rendered</h1><p data-testid="server-action-value">{value}</p><CompilerDemo/><Action/></>;
}`,
    'app/app/actions.js': `'use server';
import { cookies } from 'next/headers';
export async function save() {(await cookies()).set('react-compiler-action', 'saved on server', {httpOnly:true,sameSite:'lax'});return 'Server Action complete'}`,
    'app/app/client.jsx': `'use client';
import {useState} from 'react';import {save} from './actions';
export default function Action() {const [result,setResult] = useState('');return <form action={async()=>setResult(await save())}><button data-testid="run-action">Run Server Action</button><output data-testid="action-result">{result}</output></form>}`,
    'app/edge/page.jsx': `import CompilerDemo from '../../components/CompilerDemo';
export const runtime = 'edge';export const dynamic = 'force-dynamic';
export default function Page() {return <><h1>Edge server rendered</h1><CompilerDemo/></>}`,
  };
}

export function compilerFixtureConfig({ mode = true, webpack = false } = {}) {
  return `export default {basePath:'/docs',reactCompiler:${JSON.stringify(mode)}${webpack ? ',webpack(config) {return config}' : ''}}`;
}

export async function reactCompilerFixture({ development = false, mode = true, webpack = false } = {}) {
  const files = compilerFixtureFiles();
  const config = compilerFixtureConfig({ mode, webpack });
  if (development) return devFixture({ config, files });
  // A repository-local project resolves the same installed runtime as the real
  // CLI. Its temporary root is removed after shutdown, like devFixture's root.
  const root = await mkdtemp(path.join(repositoryRoot, '.prnext-compiler-test-'));
  try {
    for (const [name, source] of Object.entries({ ...files, 'prnext.config.mjs': config })) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
    }
    return {
      root,
      write: (name, source) => writeFile(path.join(root, name), source),
      read: name => readFile(path.join(root, name), 'utf8'),
      build: async () => {
        await promisify(execFile)(process.execPath, [path.join(repositoryRoot, 'packages/prnext/cli.mjs'), 'build', root], {
          cwd: repositoryRoot, env: { ...process.env, PRNEXT_BINARY: binary }, maxBuffer: 8 * 1024 * 1024,
        });
        return JSON.parse(await readFile(path.join(root, '.prnext/manifest.json'), 'utf8'));
      },
      remove: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
