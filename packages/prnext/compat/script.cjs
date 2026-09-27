'use client';
'use strict';

const React = require('react');
const ReactDOM = require('react-dom');
const { ScriptContext } = require('./script-context.cjs');
const { loadScript, loadLazyScript, isScriptLoaded, markScriptLoaded, handleClientScriptLoad, initScriptLoader } = require('./script-loader.cjs');

function safeJSON(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029',
  })[character]);
}

function Script(props) {
  const { id, src = '', onLoad = () => {}, onReady = null, onError, strategy = 'afterInteractive', stylesheets, ...attributes } = props;
  const context = React.useContext(ScriptContext);
  const nonce = attributes.nonce || context.nonce;
  const readyCalled = React.useRef(false);
  React.useEffect(() => {
    if (!readyCalled.current) {
      if (onReady && isScriptLoaded(id || src)) onReady();
      readyCalled.current = true;
    }
  }, [onReady, id, src]);
  const loadCalled = React.useRef(false);
  React.useEffect(() => {
    if (!loadCalled.current) {
      if (strategy === 'afterInteractive') loadScript(props);
      else if (strategy === 'lazyOnload') loadLazyScript(props);
      loadCalled.current = true;
    }
  }, [props, strategy]);

  if (!context.appDir && context.ssr) {
    if (context.collect && (context.document || strategy === 'beforeInteractive' || strategy === 'worker')) {
      context.collect({ ...props, nonce });
    } else if (!context.collect && typeof window !== 'undefined' && (strategy === 'beforeInteractive' || strategy === 'worker')) {
      markScriptLoaded(id || src);
    }
    return null;
  }
  if (!context.appDir && !context.ssr && typeof window !== 'undefined' && (strategy === 'beforeInteractive' || strategy === 'worker')) {
    loadScript({ ...props, nonce });
  }
  if (context.appDir) {
    if (stylesheets) for (const href of stylesheets) ReactDOM.preinit(href, { as: 'style' });
    if (src && (strategy === 'beforeInteractive' || strategy === 'afterInteractive')) {
      ReactDOM.preload(src, { as: 'script', nonce, crossOrigin: attributes.crossOrigin,
        ...(attributes.integrity ? { integrity: attributes.integrity } : {}) });
    }
    if (strategy === 'beforeInteractive') {
      if (!src && attributes.dangerouslySetInnerHTML) {
        attributes.children = attributes.dangerouslySetInnerHTML.__html;
        delete attributes.dangerouslySetInnerHTML;
      }
      return React.createElement('script', { nonce, dangerouslySetInnerHTML: {
        __html: `(self.__PRNEXT_SCRIPTS__=self.__PRNEXT_SCRIPTS__||[]).push(${safeJSON([src || 0, { ...attributes, id }])})`,
      } });
    }
  }
  return null;
}

Object.defineProperty(Script, '__nextScript', { value: true });
module.exports = Script;
module.exports.default = Script;
module.exports.handleClientScriptLoad = handleClientScriptLoad;
module.exports.initScriptLoader = initScriptLoader;
