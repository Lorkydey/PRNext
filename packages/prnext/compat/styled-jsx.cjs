'use client';
'use strict';
// The builder embeds this runtime in completed builds, preserving one registry
// even when the framework's npm dependencies are nested or isolated by pnpm.
module.exports={...require('styled-jsx'),css:require('styled-jsx/css.js')};
