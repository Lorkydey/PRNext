'use client';
'use strict';

const React = require('react');
const { AppRouterContext } = require('./app-context.cjs');

function initialError(value) {
  if (!value) return null;
  if (value instanceof Error) return value;
  const error = new Error(value.message || 'An error occurred while rendering this page.');
  if (value.digest !== undefined) error.digest = value.digest;
  return error;
}

function ThrowInitialError({ error }) { throw initialError(error); }

class AppErrorBoundary extends React.Component {
  static contextType = AppRouterContext;
  state = { children: this.props.children, resetKey: this.props.resetKey, error: initialError(this.props.initialError), hasError: !!this.props.initialError };

  static getDerivedStateFromError(error) {
    if (error?.digest === 'NEXT_HTTP_ERROR_FALLBACK;404' || String(error?.digest || '').startsWith('NEXT_REDIRECT;')) throw error;
    return { error, hasError: true };
  }

  static getDerivedStateFromProps(props, state) {
    if ((props.resetOnChildrenChange !== false && props.children !== state.children) || props.resetKey !== state.resetKey) {
      return { children: props.children, resetKey: props.resetKey, error: initialError(props.initialError), hasError: !!props.initialError };
    }
    return null;
  }

  reset = () => { this.setState({ error: null, hasError: false }); };

  retry = () => {
    React.startTransition(() => {
      (this.props.refresh || this.context?.router.refresh)?.();
      this.reset();
    });
  };

  render() {
    if (this.state.hasError) return React.createElement(React.Fragment, null, this.props.errorStyles,
      React.createElement(this.props.errorComponent, { error: this.state.error, reset: this.reset, retry: this.retry }));
    // A server fallback contains no successful subtree to reveal. Reset retries
    // that same encoded failure; only retry/refresh obtains new server work.
    if (this.props.initialError) return React.createElement(ThrowInitialError, { error: this.props.initialError });
    return this.props.children;
  }
}

module.exports = AppErrorBoundary;
module.exports.default = AppErrorBoundary;
