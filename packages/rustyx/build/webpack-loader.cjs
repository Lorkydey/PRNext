const {active} = require('./webpack-bridge.cjs');
module.exports = function(source, map) {
  const done = this.async();
  const bridge = active.get(this.getOptions().bridge);
  if (!bridge) return done(new Error('Rustyx webpack compilation has already closed'));
  this.cacheable(false); // Framework discovery has per-build side effects.
  bridge.transform(this, source, map).then(result => done(null, result.code, result.map), done);
};
module.exports.raw = true;
