import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AppErrorBoundary from '../compat/app-error-boundary.cjs';
import GlobalErrorBoundary, { DefaultGlobalError, GlobalErrorTrigger } from '../compat/app-global-error-boundary.cjs';
import { AppRouterProvider } from '../compat/app-context.cjs';
import { useRouter } from '../compat/navigation.cjs';

function boundary(props = {}) {
  const instance = new AppErrorBoundary({ children: React.createElement('main', null, 'healthy'), errorComponent: () => null, ...props });
  instance.setState = patch => { instance.state = { ...instance.state, ...patch }; };
  return instance;
}

test('client reset retries the same subtree without refresh while retry requests new Flight', () => {
  const events = [], failure = new Error('client failure'), instance = boundary();
  instance.context = { router: { refresh() { events.push('refresh'); } } };
  Object.assign(instance.state, AppErrorBoundary.getDerivedStateFromError(failure));
  const fallback = instance.render().props.children[1];
  assert.equal(fallback.props.error, failure);
  fallback.props.reset();
  assert.deepEqual(events, []);
  assert.equal(instance.render(), instance.props.children);
  Object.assign(instance.state, AppErrorBoundary.getDerivedStateFromError(failure));
  instance.render().props.children[1].props.retry();
  assert.deepEqual(events, ['refresh']);
  assert.equal(instance.render(), instance.props.children);
});

test('reset preserves a failed server model until retry or a replacement model arrives', () => {
  const initialError = { message: 'Sanitized server error', digest: 'public-digest' };
  const instance = boundary({ initialError, children: null, resetKey: 'old' });
  instance.reset();
  const failedChild = instance.render();
  assert.throws(() => failedChild.type(failedChild.props), error => error.message === initialError.message && error.digest === initialError.digest);
  const replacement = { ...instance.props, initialError: null, children: React.createElement('main', null, 'recovered'), resetKey: 'new' };
  Object.assign(instance.state, AppErrorBoundary.getDerivedStateFromProps(replacement, instance.state));
  instance.props = replacement;
  assert.equal(instance.render(), replacement.children);
});

test('global boundaries preserve captured failures across incidental renders and clear them for a new model', () => {
  const model = {}, failure = new Error('root failed');
  const instance = boundary({ resetKey: model, resetOnChildrenChange: false });
  Object.assign(instance.state, AppErrorBoundary.getDerivedStateFromError(failure));
  assert.equal(AppErrorBoundary.getDerivedStateFromProps({ ...instance.props, children: React.createElement('div') }, instance.state), null);
  const next = { ...instance.props, resetKey: {} };
  Object.assign(instance.state, AppErrorBoundary.getDerivedStateFromProps(next, instance.state));
  assert.equal(instance.state.hasError, false);
});

test('navigation control errors pass through and falsy client exceptions still reach the fallback', () => {
  for (const digest of ['NEXT_HTTP_ERROR_FALLBACK;404', 'NEXT_REDIRECT;replace;/target;307;']) {
    const error = Object.assign(new Error('control'), { digest });
    assert.throws(() => AppErrorBoundary.getDerivedStateFromError(error), actual => actual === error);
  }
  for (const error of [null, undefined, false, 0, 'client string']) {
    const instance = boundary();
    Object.assign(instance.state, AppErrorBoundary.getDerivedStateFromError(error));
    assert.equal(instance.render().props.children[1].props.error, error);
  }
});

test('global server summaries expose only message and digest while client Errors retain their identity', () => {
  const clientError = Object.assign(new Error('client detail'), { code: 'CUSTOM_CLIENT' });
  assert.throws(() => GlobalErrorTrigger({ error: clientError }), actual => actual === clientError);
  assert.throws(() => GlobalErrorTrigger({ error: {
    message: 'Sanitized error', digest: '123abc', stack: 'private server stack', code: 'PRIVATE_CODE', privateValue: 'secret',
  } }), error => error.message === 'Sanitized error' && error.digest === '123abc' && !error.stack.includes('private server stack') &&
    error.code === undefined && error.privateValue === undefined);
});

test('custom global fallback has router context, its own document and only its declared styles', () => {
  const controller = { refresh() {} };
  function CustomError({ error, reset, retry }) {
    assert.equal(useRouter(), controller);
    assert.equal(typeof reset, 'function'); assert.equal(typeof retry, 'function');
    return React.createElement('html', { lang: 'fr' }, React.createElement('body', null, error.message));
  }
  const html = renderToStaticMarkup(React.createElement(AppRouterProvider, { router: { pathname: '/broken' }, controller },
    React.createElement(GlobalErrorBoundary, { component: CustomError, css: ['https://cdn.test/global.css'], initialError: { message: 'Public failure' } },
      React.createElement('html', null, React.createElement('body', null, 'root layout')))));
  assert.match(html, /<html lang="fr">/);
  assert.match(html, /https:\/\/cdn.test\/global.css/);
  assert.match(html, /Public failure/);
  assert.doesNotMatch(html, /root layout/);
});

test('the builtin last resort never prints a raw exception message or stack', () => {
  const html = renderToStaticMarkup(React.createElement(DefaultGlobalError, {
    error: Object.assign(new Error('PRIVATE_MESSAGE'), { digest: 'public-digest' }),
  }));
  assert.match(html, /This page couldn’t load/);
  assert.match(html, /public-digest/);
  assert.doesNotMatch(html, /PRIVATE_MESSAGE/);
  const healthy = renderToStaticMarkup(React.createElement(GlobalErrorBoundary, { css: ['/global-error.css'] },
    React.createElement('html', null, React.createElement('body', null, 'healthy'))));
  assert.doesNotMatch(healthy, /global-error.css/);
});
