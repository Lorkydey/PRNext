import React from 'react';
import DefaultApp, { loadGetInitialProps } from '../compat/app.cjs';
import { RouterProvider, makeRouter } from '../compat/router.cjs';
import { HeadProvider } from '../compat/head.cjs';

export function applicationProps(data = {}) {
  const { pageProps, __N_SSG, __N_SSP, __PRNEXT_ROUTER__, notFound, ...appProps } = data;
  return appProps;
}

export async function loadPageInitialProps({ Page, App = DefaultApp, context, routerSnapshot, appTreePage = Page }) {
  const router = makeRouter(routerSnapshot);
  function AppTree({ pageProps = {}, ...appProps }) {
    return React.createElement(RouterProvider, { router: routerSnapshot, managed: true },
      React.createElement(HeadProvider, null,
        React.createElement(App, { ...appProps, Component: appTreePage, pageProps, router })));
  }
  const result = await loadGetInitialProps(App, { Component: Page, router, AppTree, ctx: { ...context, AppTree } });
  const { pageProps, ...appProps } = result;
  return { props: { ...pageProps }, appProps };
}

function finishHook(slots, rejected, value) {
  slots.pending--;
  if (rejected) throw value;
  return value;
}

export function createInitialPropsRunner({ limit = 8 } = {}) {
  const slots = { pending: 0 };
  return options => {
    const appHook = options.App?.getInitialProps;
    if ((!appHook || appHook === DefaultApp.origGetInitialProps) && typeof options.Page.getInitialProps !== 'function') {
      return Promise.resolve({ props: {}, appProps: {} });
    }
    // A user promise cannot be forcibly cancelled. Count abandoned hooks until
    // they settle, so repeated cancelled navigations cannot start unlimited
    // unfinished hooks holding their contexts and application code.
    if (slots.pending >= limit) return Promise.reject(new Error('Too many unfinished getInitialProps calls'));
    slots.pending++;
    return loadPageInitialProps(options).then(finishHook.bind(null, slots, false), finishHook.bind(null, slots, true));
  };
}
