'use strict';
const {transform}=require('lightningcss');
module.exports=function(css,options){
  // styled-jsx replaces interpolations with valid CSS placeholders before
  // calling plugins, then restores them after scoping.
  return transform({filename:options.babel?.filename||'styled-jsx.css',code:Buffer.from(css),minify:!options.development,sourceMap:false}).code.toString();
};
