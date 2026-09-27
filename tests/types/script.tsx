import Script, { handleClientScriptLoad, initScriptLoader, type ScriptProps, type Props } from 'next/script';
import PRNextScript, { type ScriptProps as PRNextScriptProps } from 'prnext/script';
import type { NextConfig } from '../../packages/prnext/compat/index.d.ts';

export const workerConfig: NextConfig = { experimental: { nextScriptWorkers: true } };

const script: ScriptProps = {
  id: 'analytics', src: '/analytics.js', strategy: 'lazyOnload', nonce: 'nonce',
  crossOrigin: 'anonymous', integrity: 'sha256-example', referrerPolicy: 'no-referrer',
  stylesheets: ['/analytics.css'], onLoad: event => void event.target,
  onReady: () => null, onError: event => void event.message,
};
const legacy: Props = script;
const native: PRNextScriptProps = legacy;
handleClientScriptLoad(script);
initScriptLoader([native]);

export default function ScriptTypes() {
  return <>
    <Script {...script} />
    <PRNextScript strategy="beforeInteractive" id="inline">{'window.started = true'}</PRNextScript>
    <Script strategy="worker" src="/worker.js" />
    <Script dangerouslySetInnerHTML={{ __html: 'window.started = true' }} />
    {/* @ts-expect-error Unknown script strategies are rejected. */}
    <Script strategy="idle" src="/bad.js" />
    {/* @ts-expect-error Stylesheet URLs must be strings. */}
    <Script stylesheets={[false]} />
  </>;
}
