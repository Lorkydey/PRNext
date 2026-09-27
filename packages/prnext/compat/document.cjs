'use strict';
const React = require('react');
const DocumentContext = React.createContext(null);
function context(value) {
  if (!value) throw new Error('Html, Head, Main and NextScript from next/document must only be rendered in pages/_document');
  return value;
}
function safeJSON(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' })[character]);
}
function Html(props) {
  const state = context(React.useContext(DocumentContext));
  state.rendered.add('Html');
  return React.createElement('html', { lang: state.__NEXT_DATA__?.locale, ...props });
}
class Head extends React.Component {
  static contextType = DocumentContext;
  getCssLinks() {
    const state = context(this.context);
    return state.css.map(href => React.createElement('link', { key: href, rel: 'stylesheet', href,
      nonce: this.props.nonce || state.nonce, crossOrigin: this.props.crossOrigin || state.crossOrigin }));
  }
  getScripts() {
    const state = context(this.context);
    return state.client ? [React.createElement('script', { key: state.client, type: 'module', src: state.client,
      nonce: this.props.nonce || state.nonce, crossOrigin: this.props.crossOrigin || state.crossOrigin })] : [];
  }
  getFontLinks() {
    const state = context(this.context);
    return (state.fonts || []).map(font => React.createElement('link', { key: font.href, rel: 'preload', as: 'font',
      href: font.href, type: font.type, crossOrigin: 'anonymous', nonce: this.props.nonce || state.nonce }));
  }
  render() {
    const state = context(this.context);
    state.rendered.add('Head');
    const { children, nonce, crossOrigin, ...props } = this.props;
    state.headNonce = nonce || state.nonce;
    state.headCrossOrigin = crossOrigin || state.crossOrigin;
    return React.createElement('head', props, state.head, children, this.getFontLinks(), this.getCssLinks(),
      React.createElement('prnext-document-script-target'), this.getScripts(), state.styles);
  }
}
function Main() {
  const state = context(React.useContext(DocumentContext));
  state.rendered.add('Main');
  return React.createElement('prnext-document-body-target');
}
class NextScript extends React.Component {
  static contextType = DocumentContext;
  static getInlineScriptSource(state) { return safeJSON(state.__NEXT_DATA__); }
  render() {
    const state = context(this.context);
    state.rendered.add('NextScript');
    const nonce = this.props.nonce || state.nonce;
    const crossOrigin = this.props.crossOrigin || state.crossOrigin;
    const payload = `window.__PRNEXT_DATA__=JSON.parse(${safeJSON(JSON.stringify(state.payload))});`;
    return React.createElement('script', { nonce, crossOrigin, dangerouslySetInnerHTML: { __html: payload } });
  }
}
class Document extends React.Component {
  static getInitialProps(ctx) { return ctx.defaultGetInitialProps(ctx); }
  render() {
    return React.createElement(Html, null, React.createElement(Head, { nonce: this.props.nonce }),
      React.createElement('body', null, React.createElement(Main), React.createElement(NextScript, { nonce: this.props.nonce })));
  }
}
module.exports = Document;
module.exports.default = Document;
module.exports.Html = Html;
module.exports.Head = Head;
module.exports.Main = Main;
module.exports.NextScript = NextScript;
module.exports.DocumentContext = DocumentContext;
