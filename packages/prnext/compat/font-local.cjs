'use strict';
module.exports = function localFont() {
  throw new Error('prnext/font/local must be compiled by PRNext. Call the font loader in a module-level const with literal options.');
};
module.exports.default = module.exports;
