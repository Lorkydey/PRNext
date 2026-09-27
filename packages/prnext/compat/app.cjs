'use strict';
const React = require('react');

// Shared by the server and browser: an App without a hook still delegates to
// its Page, while a custom App hook owns that delegation itself.
async function loadGetInitialProps(Component, context) {
  if (process.env.NODE_ENV !== 'production' && Component.prototype?.getInitialProps) {
    throw new Error(`${Component.displayName || Component.name || 'Component'}.getInitialProps must be a static method`);
  }
  const response = context.res || context.ctx?.res;
  if (!Component.getInitialProps) {
    if (context.ctx && context.Component) return { pageProps: await loadGetInitialProps(context.Component, context.ctx) };
    return {};
  }
  const props = await Component.getInitialProps(context);
  if (response?.finished || response?.headersSent || response?.writableEnded) return props;
  if (!props) throw new Error(`${Component.displayName || Component.name || 'Component'}.getInitialProps must return an object; received ${props}`);
  return props;
}

async function appGetInitialProps({ Component, ctx }) {
  return { pageProps: await loadGetInitialProps(Component, ctx) };
}

class App extends React.Component {
  static origGetInitialProps = appGetInitialProps;
  static getInitialProps = appGetInitialProps;
  render() { return React.createElement(this.props.Component, this.props.pageProps); }
}

module.exports = App;
module.exports.default = App;
module.exports.loadGetInitialProps = loadGetInitialProps;
