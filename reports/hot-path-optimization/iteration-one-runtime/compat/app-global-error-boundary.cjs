'use client';
'use strict';

const React = require('react');
const AppErrorBoundary = require('./app-error-boundary.cjs');

function DefaultGlobalError({ error }) {
  const digest = typeof error?.digest === 'string' ? error.digest : undefined;
  return React.createElement('html', { id: '__rustyx_error__' },
    React.createElement('head'),
    React.createElement('body', { style: { margin: 0, fontFamily: 'system-ui, sans-serif' } },
      React.createElement('main', { style: { minHeight: '100vh', display: 'grid', placeContent: 'center', padding: 24 } },
        React.createElement('h1', null, 'This page couldn’t load'),
        React.createElement('p', null, digest ? 'A server error occurred. Reload to try again.' : 'Reload to try again, or go back.'),
        React.createElement('form', null, React.createElement('button', { type: 'submit' }, 'Reload')),
        digest ? React.createElement('p', null, 'ERROR ', digest) : null)));
}

function GlobalErrorTrigger({ error }) {
  if (error instanceof Error) throw error;
  const failure = new Error(error.message || 'An error occurred while rendering this page.');
  if (typeof error.digest === 'string') failure.digest = error.digest;
  throw failure;
}

function GlobalErrorBoundary({ component = DefaultGlobalError, css = [], children, ...props }) {
  const styles = css.map(href => React.createElement('link', { key: href, rel: 'stylesheet', href, precedence: 'rustyx-global-error' }));
  return React.createElement(AppErrorBoundary, { ...props, resetOnChildrenChange: false, errorComponent: component, errorStyles: styles }, children);
}

module.exports = GlobalErrorBoundary;
module.exports.default = GlobalErrorBoundary;
module.exports.DefaultGlobalError = DefaultGlobalError;
module.exports.GlobalErrorTrigger = GlobalErrorTrigger;
