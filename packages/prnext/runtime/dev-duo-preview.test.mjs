import test from 'node:test';
import assert from 'node:assert/strict';
import {duoViewport,duoFoldProjection} from './dev-duo-preview.mjs';

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
test('inward projection accounts for the approaching edge and stays bounded in both axes',()=>{
  assert.deepEqual(duoFoldProjection(0),{min:0,max:2,cross:1});assert.deepEqual(duoFoldProjection(1),{min:0,max:1,cross:1});
  const edgeOn=duoFoldProjection(.5);assert.equal(edgeOn.cross,4/3);assert.equal(edgeOn.min,0);assert.ok(Math.abs(edgeOn.max-1)<1e-12);
  assert.ok(duoFoldProjection(.08).max>2,'the inward edge approaches the viewer before the profile narrows');
  assert.ok(duoFoldProjection(.92).min<0,'perspective can project the cover just past the stationary edge');
  for(let step=1;step<=100;step++){
    const {min,max,cross}=duoFoldProjection(step/100);assert.ok(min>=-.04&&min<=0);assert.ok(max>=1&&max<=2.04);assert.ok(cross>=1&&cross<=4/3);
  }
  assert.deepEqual(duoFoldProjection(-10),duoFoldProjection(0));assert.deepEqual(duoFoldProjection(10),duoFoldProjection(1));
});
