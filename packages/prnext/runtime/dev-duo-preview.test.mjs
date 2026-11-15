import test from 'node:test';
import assert from 'node:assert/strict';
import {duoViewport,duoFoldExtent} from './dev-duo-preview.mjs';

for(const [folded,rotated,width,height] of [[false,false,890,626],[true,false,466,678],[false,true,626,890],[true,true,678,466]]){
  test(`Duo ${folded?'cover':'open'} ${rotated?'rotated':'default'} layout preset`,()=>{
    const model=duoViewport(folded,rotated);assert.equal(model.width,width);assert.equal(model.height,height);
    const [top,right,bottom,left]=model.inset;
    const outerWidth=width+left+right,outerHeight=height+top+bottom;
    assert.equal(rotated?outerWidth:outerHeight,folded?702:650);
    assert.equal(rotated?outerHeight:outerWidth,folded?490:914);
    assert.equal(rotated?model.second.y:model.second.x,rotated?model.panel.height:model.panel.width);
    assert.equal(model.frontSpan,folded?466:445);assert.equal(model.gap,undefined);assert.equal(model.spine,undefined);
  });
}
test('fold projection shrinks to one continuous housing without a dead hinge gap',()=>{
  assert.equal(duoFoldExtent(0),1);assert.equal(duoFoldExtent(1),0);
  let previous=duoFoldExtent(0);
  for(let step=1;step<=100;step++){
    const extent=duoFoldExtent(step/100);assert.ok(Number.isFinite(extent)&&extent>=0&&extent<=previous);previous=extent;
  }
  assert.equal(duoFoldExtent(-10),duoFoldExtent(0));assert.equal(duoFoldExtent(10),duoFoldExtent(1));
});
