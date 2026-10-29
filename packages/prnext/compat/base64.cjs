'use strict';
// Native decoding avoids a JavaScript callback for each Flight byte. The loop
// remains available on browsers that do not implement Uint8Array.fromBase64.
function decodeBase64(value) {
  if(typeof Uint8Array.fromBase64==='function')return Uint8Array.fromBase64(value);
  const binary=atob(value),bytes=new Uint8Array(binary.length);
  for(let n=0;n<binary.length;n++)bytes[n]=binary.charCodeAt(n);
  return bytes;
}
module.exports={decodeBase64};
