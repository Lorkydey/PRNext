'use client';
'use strict';

const React = require('react');
const { AppRouterContext } = require('./app-context.cjs');

function navigation(error) {
  const digest = error?.digest;
  if (digest === 'NEXT_HTTP_ERROR_FALLBACK;404') return { notFound: true };
  if (typeof digest !== 'string' || !digest.startsWith('NEXT_REDIRECT;')) return null;
  const parts = digest.split(';');
  if (parts.at(-1) === '') parts.pop();
  const status = Number(parts.pop());
  const href = parts.slice(2).join(';');
  if (![307, 308].includes(status) || !href || /[\r\n]/.test(href)) return null;
  let url;
  try { url = new URL(href, 'http://rustyx.invalid'); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  return { href, replace: parts[1] === 'replace' };
}

class AppNavigationBoundary extends React.Component {
  static contextType = AppRouterContext;
  state = { control: null, resetKey: this.props.resetKey };
  static getDerivedStateFromError(error) {
    const control = navigation(error);
    if (!control) throw error;
    return { control };
  }
  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.resetKey ? { control: null, resetKey: props.resetKey } : null;
  }
  componentDidCatch(error) {
    const control = navigation(error);
    if (control?.href) this.context.router[control.replace ? 'replace' : 'push'](control.href);
  }
  render() {
    if (this.state.control?.notFound) return React.createElement(React.Fragment, null,
      React.createElement('meta', { name: 'robots', content: 'noindex' }), this.props.notFound);
    if (this.state.control) return null;
    return this.props.children;
  }
}

module.exports = AppNavigationBoundary;
module.exports.default = AppNavigationBoundary;
module.exports.getNavigationControl = navigation;
