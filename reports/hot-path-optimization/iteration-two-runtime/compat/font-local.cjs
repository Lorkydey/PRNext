'use strict';
module.exports = function localFont() {
  throw new Error('rustyx/font/local must be compiled by Rustyx. Call the font loader in a module-level const with literal options.');
};
module.exports.default = module.exports;
