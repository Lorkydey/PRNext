import test from 'node:test';
import assert from 'node:assert/strict';
import {isHtmlDocumentRoute} from './route-pattern.mjs';

test('HTML document navigation observes route precedence rather than matching an HTML catch-all over an interactive page',()=>{
  const routes=[{pattern:'/blog/[slug]',htmlOnly:true},{pattern:'/blog/edit'},{pattern:'/guide/[[...path]]',htmlOnly:true},{pattern:'/guide/search'},{pattern:'/guide/[section]'}];
  assert.equal(isHtmlDocumentRoute(routes,'/blog/hello%20world/'),true);
  assert.equal(isHtmlDocumentRoute(routes,'/blog/edit'),false);
  assert.equal(isHtmlDocumentRoute(routes,'/guide'),true);
  assert.equal(isHtmlDocumentRoute(routes,'/guide/chapter/deep'),true);
  assert.equal(isHtmlDocumentRoute(routes,'/guide/chapter'),false);
  assert.equal(isHtmlDocumentRoute(routes,'/guide/search'),false);
  assert.equal(isHtmlDocumentRoute(routes,'/blog/%2f'),false);
  assert.equal(isHtmlDocumentRoute(routes,'/blog/%ZZ'),false);
  assert.equal(isHtmlDocumentRoute(undefined,'/blog/demo'),false);
});
