'use client';
'use strict';
const React = require('react');
const ServerInsertedHTMLContext = React.createContext(null);
function useServerInsertedHTML(callback) {
  const register = React.useContext(ServerInsertedHTMLContext);
  register?.(callback);
}
module.exports = { ServerInsertedHTMLContext, useServerInsertedHTML };
