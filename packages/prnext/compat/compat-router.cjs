'use strict';
const React = require('react');
const {RouterContext} = require('./router.cjs');

// Shared migration components may render outside the Pages Router provider.
function useRouter() { return React.useContext(RouterContext); }
module.exports = {useRouter};
