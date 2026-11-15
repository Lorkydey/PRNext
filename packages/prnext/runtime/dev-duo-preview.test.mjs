import test from 'node:test';
import assert from 'node:assert/strict';
import {duoViewport,duoFoldExtent} from './dev-duo-preview.mjs';

for(const [folded,rotated,width,height] of [[false,false,1114,720],[true,false,540,720],[false,true,720,1114],[true,true,720,540]]){
  test(`Duo ${folded?'single':'dual'} ${rotated?'rotated':'portrait'} has the correct CSS viewport`,()=>{
    const model=duoViewport(folded,rotated);assert.equal(model.width,width);assert.equal(model.height,height);
    const [top,right,bottom,left]=model.inset;
    const outerWidth=width+left+right,outerHeight=height+top+bottom;
    assert.equal(rotated?outerWidth:outerHeight,768);
    assert.equal(rotated?outerHeight:outerWidth,folded?574:1138);
    assert.equal(rotated?model.gap.height:model.gap.width,34);
    assert.equal(rotated?model.spine.height:model.spine.width,10);
  });
}
test('fold projection is bounded and shrinks continuously to one housing plus the hinge',()=>{
  assert.equal(duoFoldExtent(0),(564+10)/564);assert.equal(duoFoldExtent(1),10/564);
  let previous=duoFoldExtent(0);
  for(let step=1;step<=100;step++){
    const extent=duoFoldExtent(step/100);assert.ok(Number.isFinite(extent)&&extent>=10/564&&extent<=previous);previous=extent;
  }
  assert.equal(duoFoldExtent(-10),duoFoldExtent(0));assert.equal(duoFoldExtent(10),duoFoldExtent(1));
});
