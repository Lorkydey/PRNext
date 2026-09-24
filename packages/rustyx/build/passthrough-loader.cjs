module.exports = function(source) {
  if (Object.keys(this.getOptions()).length) throw new Error('defaultLoaders.babel options require a Babel loader; configure babel-loader explicitly');
  return source;
};
