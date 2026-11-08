import test from 'node:test';
import assert from 'node:assert/strict';
import {presentationHtml} from './presentation-benchmark.mjs';

test('the benchmark compares rendered HTML while excluding only known self-removing Flight transport',()=>{
  const opening='<section data-testid="presentation">',ending='</section>',table='<table><tbody><tr><td>A &amp; B</td></tr></tbody></table>';
  const transport='<script>(self.__PRNEXT_FLIGHT_STREAM__||=[]).push("YWJjZA==");document.currentScript.remove()</script>';
  const expected=opening+table+ending;
  assert.equal(presentationHtml(opening+transport+table+ending),expected);
  assert.equal(presentationHtml(opening+table+transport.replace('<script>','<script nonce="test">')+ending),expected);
  for(const script of ['<script>unexpected()</script>',transport.replace('document.currentScript.remove()','unexpected()'),transport.replace('YWJjZA==','not base64')]) assert.throws(()=>presentationHtml(opening+table+script+ending),/Unexpected script/);
  assert.throws(()=>presentationHtml('<main>Missing</main>'),/section must be present/);
});
