'use strict';
const React = require('react');
const Head = require('./head.cjs');

const titles = { 400: 'Bad Request', 404: 'This page could not be found', 405: 'Method Not Allowed', 500: 'Internal Server Error' };

function getInitialProps({ req, res, err }) {
  const statusCode = res?.statusCode || (err ? err.statusCode : 404);
  let hostname;
  if (typeof window !== 'undefined') hostname = window.location.hostname;
  else if (req?.headers?.host) {
    try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { /* An invalid Host is not page content. */ }
  }
  return { statusCode, hostname };
}

class ErrorPage extends React.Component {
  static displayName = 'ErrorPage';
  static getInitialProps = getInitialProps;
  static origGetInitialProps = getInitialProps;
  render() {
    const { statusCode, hostname, withDarkMode = true } = this.props;
    const title = this.props.title || titles[statusCode] || 'An unexpected error has occurred';
    const clientTitle = 'Application error: a client-side exception has occurred';
    const description = this.props.title || statusCode ? title
      : `${clientTitle}${hostname ? ` while loading ${hostname}` : ''} (see the browser console for more information)`;
    return React.createElement('div', { style: { fontFamily: 'system-ui, sans-serif', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' } },
      React.createElement(Head, null, React.createElement('title', null, statusCode ? `${statusCode}: ${title}` : clientTitle)),
      React.createElement('style', null, `body{margin:0;color:#000;background:#fff}.rustyx-error-code{border-right:1px solid rgba(0,0,0,.3)}${withDarkMode ? '@media(prefers-color-scheme:dark){body{color:#fff;background:#000}.rustyx-error-code{border-color:rgba(255,255,255,.3)}}' : ''}`),
      React.createElement('div', null,
        statusCode ? React.createElement('h1', { className: 'rustyx-error-code', style: { display: 'inline-block', margin: '0 20px 0 0', paddingRight: 23, fontSize: 24, fontWeight: 500, lineHeight: '48px', verticalAlign: 'top' } }, statusCode) : null,
        React.createElement('div', { style: { display: 'inline-block' } }, React.createElement('h2', { style: { fontSize: 14, fontWeight: 400, lineHeight: '28px' } }, `${description}.`))));
  }
}
module.exports = ErrorPage;
module.exports.default = ErrorPage;
