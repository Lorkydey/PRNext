'use client';
'use strict';
const React = require('react');
const idle = Object.freeze({ pending: false });
const LinkStatusContext = React.createContext(idle);
function useLinkStatus() { return React.useContext(LinkStatusContext); }
module.exports = { LinkStatusContext, useLinkStatus };
