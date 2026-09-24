import React from 'react';
import DefaultDocument, { DocumentContext } from '../compat/document.cjs';
import DefaultApp from '../compat/app.cjs';
import { RouterProvider, useRouter } from '../compat/router.cjs';
import { HeadProvider, dedupeHead } from '../compat/head.cjs';
import { DynamicProvider, preloadAll } from '../compat/dynamic.cjs';
import { MAX_RESPONSE_BYTES } from './http.mjs';
import { ScriptContext } from '../compat/script-context.cjs';
import { completePageScripts } from './script-html.mjs';

function PageEntry({ App, Component, pageProps, appProps }) {
  const router = useRouter();
  return React.createElement(App, { ...appProps, Component, pageProps, router });
}
function defaultHead() {
  return [React.createElement('meta', { charSet: 'utf-8' }),
    React.createElement('meta', { name: 'viewport', content: 'width=device-width' })];
}

export async function renderDocument({ Document = DefaultDocument, App = DefaultApp, Page, props, appProps = {}, snapshot, route,
  request, response, error, production, buildId, manifest, isStatic, hasServerProps, hasPageInitialProps, hasAppInitialProps }) {
  if (typeof Document !== 'function' && (!Document || typeof Document !== 'object')) throw new TypeError('pages/_document must export a React component as default');
  const { renderToString, renderToStaticMarkup } = await import('react-dom/server');
  await preloadAll();
  const dynamicModules = new Set();
  const pageScripts = [], documentScripts = [];
  const scriptContext = { appDir: false, ssr: true, document: false, collect: props => pageScripts.push(props) };
  let renderedHead = defaultHead();
  const tree = (EnhancedApp, EnhancedPage, pageProps, collector, appProps) =>
    React.createElement(manifest?.config?.reactStrictMode ? React.StrictMode : React.Fragment, null, React.createElement(RouterProvider, { router: snapshot }, React.createElement(HeadProvider, { collector },
      React.createElement(DynamicProvider, { modules: dynamicModules },
        React.createElement(ScriptContext.Provider, { value: scriptContext },
          React.createElement(PageEntry, { App: EnhancedApp, Component: EnhancedPage, pageProps, appProps }))))));
  const renderPage = async (options = {}) => {
    if (typeof options === 'function') options = { enhanceComponent: options };
    if (!options || typeof options !== 'object') throw new TypeError('Document renderPage expects component enhancers');
    const EnhancedApp = options.enhanceApp ? options.enhanceApp(App) : App;
    const EnhancedPage = options.enhanceComponent ? options.enhanceComponent(Page) : Page;
    await preloadAll();
    pageScripts.length = 0;
    const collector = [];
    const html = `<div id="__rustyx">${renderToString(tree(EnhancedApp, EnhancedPage, props, collector, appProps))}</div>`;
    if (Buffer.byteLength(html) > MAX_RESPONSE_BYTES) throw new Error('Response exceeds the 16 MiB Rustyx limit');
    renderedHead = dedupeHead([...defaultHead(), ...collector]);
    return { html, head: renderedHead };
  };
  const AppTree = ({ pageProps = {}, ...appProps }) => tree(App, Page, pageProps, [], appProps);
  const builtinError = route.internal && route.errorStatus;
  const autoStatic = !builtinError && !isStatic && !hasServerProps && !hasPageInitialProps && !hasAppInitialProps;
  const autoAsPath = snapshot.pathname + (request.url.endsWith('/') && !snapshot.pathname.endsWith('/') && !snapshot.pathname.includes('[') ? '/' : '');
  const documentAsPath = builtinError ? `/${route.errorStatus}` : autoStatic ? autoAsPath : snapshot.asPath;
  const context = { err: error, req: autoStatic ? undefined : request, res: autoStatic ? undefined : response, pathname: snapshot.pathname,
    query: autoStatic ? {} : snapshot.query, asPath: documentAsPath, AppTree, renderPage,
    async defaultGetInitialProps(ctx) {
      const result = await ctx.renderPage({ enhanceApp: Component => Component });
      return { html: result.html, head: result.head, styles: [] };
    } };
  let initial;
  const hasInitialProps = typeof Document.getInitialProps === 'function';
  if (hasInitialProps) initial = await Document.getInitialProps(context);
  else initial = { ...await renderPage(), styles: [] };
  if (response.writableEnded) return { ended: true };
  if (!initial || typeof initial !== 'object' || Array.isArray(initial) || typeof initial.html !== 'string') {
    throw new TypeError('Document.getInitialProps must return an object with an html string');
  }
  if (Buffer.byteLength(initial.html) > MAX_RESPONSE_BYTES) throw new Error('Response exceeds the 16 MiB Rustyx limit');
  const payload = { props, appProps, router: snapshot, buildId, route: { pattern: snapshot.pathname }, dynamicIds: [...dynamicModules] };
  const assetPrefix = manifest?.config?.assetPrefix || manifest?.config?.basePath || '';
  const nextData = { props: { ...appProps, pageProps: props }, page: snapshot.pathname, query: snapshot.query, buildId,
    ...(snapshot.locale ? {locale:snapshot.locale,locales:snapshot.locales,defaultLocale:snapshot.defaultLocale} : {}),
    ...(assetPrefix ? { assetPrefix } : {}),
    isFallback: snapshot.isFallback, ...(isStatic ? { gsp: true } : {}), ...(hasServerProps ? { gssp: true } : {}),
    ...(hasPageInitialProps ? { gip: true } : {}), ...(hasAppInitialProps ? { appGip: true } : {}) };
  const head = React.Children.toArray(initial.head).map((element, key) => React.isValidElement(element)
    ? React.cloneElement(element, { key, 'data-rustyx-head': '' }) : element);
  const state = { html: initial.html, head, styles: initial.styles, rendered: new Set(), payload,
    client: route.client, css: route.css || [], fonts: route.fonts || [], __NEXT_DATA__: nextData };
  const documentProps = { __NEXT_DATA__: nextData, assetPrefix,
    dangerousAsPath: documentAsPath, isDevelopment: !production, ...initial };
  if (!hasInitialProps) delete documentProps.html;
  state.nonce = documentProps.nonce;
  state.crossOrigin = documentProps.crossOrigin;
  let markup = renderToStaticMarkup(React.createElement(DocumentContext.Provider, { value: state },
    React.createElement(ScriptContext.Provider, { value: { ...scriptContext, document: true, collect: props => documentScripts.push(props) } },
      React.createElement(Document, documentProps))))
    .replace('<rustyx-document-body-target></rustyx-document-body-target>', () => initial.html);
  markup = completePageScripts(markup, { pageScripts, documentScripts, worker: manifest?.scriptWorkers,
    nonce: state.headNonce || state.nonce, crossOrigin: state.headCrossOrigin || state.crossOrigin }, renderToStaticMarkup);
  if (!production) {
    const missing = ['Html', 'Head', 'Main', 'NextScript'].filter(name => !state.rendered.has(name));
    if (missing.length) console.warn(`Your custom Document did not render the required components: ${missing.map(name => `<${name} />`).join(', ')}`);
  }
  const html = /^<!doctype html>/i.test(markup) ? markup : `<!DOCTYPE html>${markup}`;
  if (Buffer.byteLength(html) > MAX_RESPONSE_BYTES) throw new Error('Response exceeds the 16 MiB Rustyx limit');
  return { html };
}
