import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {useRouter} from '../compat/compat-router.cjs';
import {RouterProvider} from '../compat/router.cjs';

test('compat useRouter can render outside a router and shares the Pages provider',()=>{
  function Shared(){const router=useRouter();return React.createElement('p',null,router?.pathname || 'absent');}
  assert.equal(renderToString(React.createElement(Shared)),'<p>absent</p>');
  assert.equal(renderToString(React.createElement(RouterProvider,{router:{pathname:'/legacy'}},React.createElement(Shared))),'<p>/legacy</p>');
});
