export const duoPreviewStyle = `
  .wb-frame-wrap[data-device=duo]{background:transparent}
  .wb-frame-wrap[data-device=duo]::before,.wb-frame-wrap[data-device=duo]>.wb-device-top,.wb-frame-wrap[data-device=duo]>.wb-device-home{display:none}
  .wb-duo-layer{position:absolute;inset:0;z-index:3;pointer-events:none;transform-style:preserve-3d}
  .wb-duo-layer[hidden],.wb-duo-layer [hidden]{display:none!important}
  .wb-duo-panel,.wb-duo-leaf{position:absolute;border:1px solid #343434;border-radius:var(--duo-radius);background:linear-gradient(#121212,#121212) top/100% var(--duo-end) no-repeat,linear-gradient(#121212,#121212) bottom/100% var(--duo-end) no-repeat,linear-gradient(#121212,#121212) left/var(--duo-side) 100% no-repeat,linear-gradient(#121212,#121212) right/var(--duo-side) 100% no-repeat;box-shadow:inset 0 0 0 1px #ffffff04}
  .wb-duo-panel::before,.wb-duo-leaf::before{content:'';position:absolute;top:calc(var(--duo-end) * .44);left:50%;width:calc(var(--duo-side) * 3);height:2px;translate:-50% 0;border-radius:2px;background:#333}
  .wb-duo-layer[data-rotated=true] .wb-duo-panel::before,.wb-duo-layer[data-rotated=true] .wb-duo-leaf::before{left:calc(var(--duo-side) * .44);top:50%;width:2px;height:calc(var(--duo-end) * 3);translate:0 -50%}
  .wb-duo-gap{position:absolute;background:#121212;pointer-events:auto;cursor:default}
  .wb-duo-spine{position:absolute;z-index:3;background:linear-gradient(90deg,#080808,#323232 35%,#151515 65%,#080808)}
  .wb-duo-spine::before,.wb-duo-spine::after{content:'';position:absolute;left:1px;right:1px;height:7%;top:17%;border-radius:3px;background:linear-gradient(90deg,#1a1a1a,#555 40%,#202020);box-shadow:inset 0 1px #ffffff18,0 1px 3px #000}
  .wb-duo-spine::after{top:auto;bottom:17%}
  .wb-duo-layer[data-rotated=true] .wb-duo-spine{background:linear-gradient(#080808,#323232 35%,#151515 65%,#080808)}
  .wb-duo-layer[data-rotated=true] .wb-duo-spine::before,.wb-duo-layer[data-rotated=true] .wb-duo-spine::after{top:1px;bottom:1px;width:7%;height:auto;left:17%;right:auto;background:linear-gradient(#1a1a1a,#555 40%,#202020)}
  .wb-duo-layer[data-rotated=true] .wb-duo-spine::after{left:auto;right:17%}
  .wb-duo-leaf{backface-visibility:hidden;transform-style:preserve-3d}
  .wb-duo-glass{position:absolute;inset:var(--duo-end) var(--duo-side);border-radius:var(--duo-glass-radius);background:linear-gradient(135deg,#17191b,#080808 42%,#131416);box-shadow:inset 1px 0 #ffffff08}
  .wb-frame-wrap[data-fold-animating=true] .wb-duo-second{visibility:hidden}
  .wb-frame-wrap[data-fold-animating=true] .wb-screen{pointer-events:none}
  .wb-frame-wrap[data-fold-animating=true] iframe{pointer-events:none}
  .wb .wb-duo-fold{display:flex;align-items:center;justify-content:center;gap:6px;width:88px;padding:6px 9px}
  .wb-preview-actions{flex-wrap:wrap;max-width:100%}
  @media(max-width:640px){.wb .wb-duo-fold{width:34px;padding:6px}.wb-duo-fold span{display:none}}
  @media(pointer:coarse) and (min-width:641px){.wb .wb-duo-fold{width:88px}}
  @media(pointer:coarse) and (max-width:640px){.wb .wb-duo-fold{width:44px}}
  @media(forced-colors:active){.wb-duo-panel,.wb-duo-leaf{border-color:CanvasText}.wb-duo-gap,.wb-duo-spine{background:Canvas}.wb-duo-glass{background:Canvas;box-shadow:none}}
`;
