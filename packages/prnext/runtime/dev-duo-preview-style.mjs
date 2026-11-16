export const duoPreviewStyle = `
  .wb-frame-wrap[data-device=duo]{background:transparent}
  .wb-frame-wrap[data-device=duo]::before,.wb-frame-wrap[data-device=duo]>.wb-device-top,.wb-frame-wrap[data-device=duo]>.wb-device-home{display:none}
  .wb-duo-layer{position:absolute;inset:0;z-index:3;pointer-events:none;transform-style:preserve-3d}
  .wb-duo-layer[hidden],.wb-duo-layer [hidden]{display:none!important}
  .wb-duo-panel{position:absolute}
  .wb-duo-shell,.wb-duo-inner-face,.wb-duo-cover-face{position:absolute;border:1px solid #343434;border-radius:var(--duo-radius);background:linear-gradient(#121212,#121212) top/100% var(--duo-bezel) no-repeat,linear-gradient(#121212,#121212) bottom/100% var(--duo-bezel) no-repeat,linear-gradient(#121212,#121212) left/var(--duo-bezel) 100% no-repeat,linear-gradient(#121212,#121212) right/var(--duo-bezel) 100% no-repeat;box-shadow:inset 0 0 0 1px #ffffff04}
  .wb-duo-shell{inset:0}
  .wb-duo-crease{position:absolute;opacity:.18;pointer-events:none;background:linear-gradient(90deg,transparent,#0002 42%,#ffffff08 55%,transparent)}
  .wb-duo-layer[data-rotated=true] .wb-duo-crease{background:linear-gradient(transparent,#0002 42%,#ffffff08 55%,transparent)}
  .wb-duo-leaf{position:absolute;transform-style:preserve-3d}
  .wb-duo-inner-face,.wb-duo-cover-face{inset:0;backface-visibility:hidden}
  .wb-duo-inner-face{border-left-width:0;border-radius:0 var(--duo-radius) var(--duo-radius) 0;background-size:100% var(--duo-bezel),100% var(--duo-bezel),0 100%,var(--duo-bezel) 100%;box-shadow:none}
  .wb-duo-layer[data-rotated=true] .wb-duo-inner-face{border-left-width:1px;border-top-width:0;border-radius:0 0 var(--duo-radius) var(--duo-radius);background-size:100% 0,100% var(--duo-bezel),var(--duo-bezel) 100%,var(--duo-bezel) 100%}
  .wb-duo-cover-face{transform:rotateY(180deg) translateZ(.6px);background-color:#101010}
  .wb-duo-layer[data-rotated=true] .wb-duo-cover-face{transform:rotateX(180deg) translateZ(.6px)}
  .wb-duo-camera{position:absolute;top:calc(var(--duo-bezel) * .32);right:calc(var(--duo-bezel) * 1.8);width:calc(var(--duo-bezel) * .38);aspect-ratio:1;border-radius:50%;background:#030303;box-shadow:0 0 0 1px #ffffff12}
  .wb-duo-layer[data-rotated=true] .wb-duo-camera{top:auto;bottom:calc(var(--duo-bezel) * 1.8);right:calc(var(--duo-bezel) * .32)}
  .wb-frame-wrap[data-folded=false] .wb-duo-static-camera,.wb-frame-wrap[data-fold-animating=true] .wb-duo-static-camera{display:none}
  .wb-duo-glass{position:absolute;inset:var(--duo-bezel);border-radius:var(--duo-glass-radius);background:linear-gradient(135deg,#17191b,#080808 42%,#131416);box-shadow:inset 1px 0 #ffffff08}
  .wb-duo-inner-face .wb-duo-glass{left:0;border-radius:0 var(--duo-glass-radius) var(--duo-glass-radius) 0;box-shadow:none}
  .wb-duo-layer[data-rotated=true] .wb-duo-inner-face .wb-duo-glass{left:var(--duo-bezel);top:0;border-radius:0 0 var(--duo-glass-radius) var(--duo-glass-radius)}
  .wb-frame-wrap[data-fold-animating=true] .wb-duo-shell{width:var(--duo-panel-width);height:var(--duo-panel-height);border-right-width:0;border-radius:var(--duo-radius) 0 0 var(--duo-radius);background-size:100% var(--duo-bezel),100% var(--duo-bezel),var(--duo-bezel) 100%,0 100%;box-shadow:none}
  .wb-frame-wrap[data-fold-animating=true][data-rotated=true] .wb-duo-shell{border-right-width:1px;border-bottom-width:0;border-radius:var(--duo-radius) var(--duo-radius) 0 0;background-size:100% var(--duo-bezel),100% 0,var(--duo-bezel) 100%,var(--duo-bezel) 100%}
  .wb-frame-wrap[data-fold-animating=true] .wb-duo-crease{display:none}
  .wb-frame-wrap[data-fold-animating=true] .wb-screen{pointer-events:none;z-index:4}
  .wb-frame-wrap[data-fold-animating=true] iframe{pointer-events:none}
  .wb .wb-duo-fold{display:flex;align-items:center;justify-content:center;gap:6px;width:88px;padding:6px 9px}
  .wb-preview-actions{flex-wrap:wrap;max-width:100%}
  @media(max-width:640px){.wb .wb-duo-fold{width:34px;padding:6px}.wb-duo-fold span{display:none}}
  @media(pointer:coarse) and (min-width:641px){.wb .wb-duo-fold{width:88px}}
  @media(pointer:coarse) and (max-width:640px){.wb .wb-duo-fold{width:44px}}
  @media(forced-colors:active){.wb-duo-shell,.wb-duo-inner-face,.wb-duo-cover-face{border-color:CanvasText}.wb-duo-crease{background:none}.wb-duo-glass{background:Canvas;box-shadow:none}}
`;
