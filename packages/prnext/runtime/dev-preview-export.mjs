const blocked=new Set(['SCRIPT','NOSCRIPT','LINK','BASE','IFRAME','OBJECT','EMBED']);
function abortable(promise,signal){
  if(!signal)return promise;signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
function applicationNode(node){
  if(node.nodeType!==1)return true;
  if(blocked.has(node.tagName))return false;
  for(let current=node;current;current=current.getRootNode?.().host)if(current.closest?.('prnext-dev-tools,prnext-dev-window,prnext-dev-picker,#__prnext_dev_error__,#__prnext_reload_reason__'))return false;
  return true;
}
export function pngGeometry(model){
  const {width,height}=model;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192||width*height>16_000_000)throw Error('The preview is too large to export.');
  const inset=model.frameEnabled?model.inset:[0,0,0,0];
  if(!Array.isArray(inset)||inset.length!==4||inset.some(n=>!Number.isFinite(n)||n<0||n>64))throw Error('Invalid device frame.');
  const [top,right,bottom,left]=inset;
  if((width+left+right)*(height+top+bottom)>16_000_000)throw Error('The preview is too large to export.');
  return {width:width+left+right,height:height+top+bottom,left,top,inset};
}
function visible(node,view,width,height){const r=node.getBoundingClientRect(),s=view.getComputedStyle(node);return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<width&&r.top<height&&s.display!=='none'&&s.visibility!=='hidden';}
function pairNodes(source,clone,filter,visit){
  visit(source,clone);if(source.nodeType!==1||source.localName==='svg'||['CANVAS','VIDEO'].includes(source.tagName))return;
  const children=[...(source.shadowRoot||source).childNodes],copies=[...clone.childNodes];let index=0;
  for(const child of children){
    if(!filter(child))continue;
    while(index<copies.length){const copy=copies[index++];if(child.nodeType===copy.nodeType&&(child.nodeType!==1||child.localName===copy.localName||(['CANVAS','VIDEO'].includes(child.tagName)&&copy.localName==='img'))){pairNodes(child,copy,filter,visit);break;}}
  }
}
// Keep viewport-affixed headers in their observed position after translating a
// scrolled document. Work only on the inert SVG clone, never on the application.
function positionAffixed(source,clone,view,scrollX,scrollY,pairs){
  const overlays=[];
  for(const [node,copy] of pairs){
    if(node.nodeType!==1||!copy.style)continue;
    const style=view.getComputedStyle(node);if(!['fixed','sticky'].includes(style.position)||!visible(node,view,view.innerWidth,view.innerHeight))continue;
    if(overlays.some(entry=>entry.source.contains(node)))continue;
    let transformed=false;for(let parent=node.parentElement;parent&&parent!==source;parent=parent.parentElement){const s=view.getComputedStyle(parent);if(s.transform!=='none'||s.perspective!=='none'||s.filter!=='none'){transformed=true;break;}}if(transformed)continue;
    const rect=node.getBoundingClientRect(),overlay=copy.cloneNode(true);
    Object.assign(overlay.style,{position:'absolute',left:rect.left+scrollX+'px',top:rect.top+scrollY+'px',right:'auto',bottom:'auto',width:rect.width+'px',height:rect.height+'px',boxSizing:'border-box',margin:'0px',transform:'none',visibility:'visible',zIndex:style.zIndex==='auto'?'0':style.zIndex});
    overlays.push({source:node,copy,overlay});
  }
  for(const {copy,overlay} of overlays){copy.style.visibility='hidden';clone.append(overlay);}
}
async function restoreViewportState(pairs,view,signal){
  const images=new Map();
  async function imageData(url){
    if(url.startsWith('data:'))return url;
    if(!images.has(url))images.set(url,(async()=>{
      const response=await view.fetch(url,{signal,credentials:'same-origin'});if(!response.ok)throw Error('A responsive image could not be exported. Check image access.');
      const blob=await response.blob();return new Promise((resolve,reject)=>{const reader=new view.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('A responsive image could not be read.'));reader.readAsDataURL(blob);});
    })());return images.get(url);
  }
  const pending=[];
  for(const [node,copy] of pairs){
    if(node.nodeType!==1)continue;
    if(node.localName==='img'){
      // html-to-image embeds img.src, which can be a fallback different from
      // the selected picture/srcset candidate. Freeze the observed source.
      copy.removeAttribute('srcset');copy.removeAttribute('sizes');
      if(node.currentSrc&&node.currentSrc!==node.src)pending.push(imageData(node.currentSrc).then(data=>copy.setAttribute('src',data)));
    }
    if(node.localName==='picture')for(const child of [...copy.children])if(child.localName==='source')child.remove();
    if(node===node.ownerDocument.scrollingElement||(!node.scrollLeft&&!node.scrollTop))continue;
    const translate=`translate(${-node.scrollLeft}px,${-node.scrollTop}px)`;
    for(const child of [...copy.childNodes]){
      if(child.nodeType===1&&child.style){const previous=child.style.transform;child.style.transform=translate+(previous&&previous!=='none'?' '+previous:'');}
      else if(child.nodeType===3){const span=copy.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml','span');span.style.position='relative';span.style.left=-node.scrollLeft+'px';span.style.top=-node.scrollTop+'px';child.replaceWith(span);span.append(child);}
    }
  }
  await abortable(Promise.all(pending),signal);
}
async function viewportCanvas(frame,signal){
  const view=frame.contentWindow,document=view.document,width=view.innerWidth,height=view.innerHeight;
  if(view.location.origin!==frame.ownerDocument.defaultView.location.origin)throw Error('Only same-origin previews can be exported.');
  const root=document.documentElement;if(!root)throw Error('The preview is still loading.');
  if(root.querySelectorAll('*').length>20000)throw Error('The preview contains too many elements to export.');
  for(const node of root.querySelectorAll('iframe,object,embed'))if(applicationNode(node.parentElement)&&visible(node,view,width,height))throw Error('Visible embedded frames cannot be included in a PNG.');
  const scrollX=view.scrollX,scrollY=view.scrollY;
  const {toSvg}=await import('html-to-image');signal?.throwIfAborted();
  const uri=await abortable(toSvg(root,{width,height,pixelRatio:1,cacheBust:false,includeQueryParams:true,filter:applicationNode,fetchRequestInit:{signal},onImageErrorHandler:()=>{throw Error('A preview image could not be exported. Check image access and CORS.');},style:{width:width+'px',height:height+'px',margin:'0px',transform:`translate(${-scrollX}px,${-scrollY}px)`,transformOrigin:'0 0'}}),signal);
  signal?.throwIfAborted();
  const xml=decodeURIComponent(uri.slice(uri.indexOf(',')+1)),tree=new view.DOMParser().parseFromString(xml,'image/svg+xml');
  const clone=tree.querySelector('foreignObject')?.firstElementChild;if(!clone||tree.querySelector('parsererror'))throw Error('The preview could not be rendered.');
  const pairs=[];pairNodes(root,clone,applicationNode,(source,copy)=>pairs.push([source,copy]));
  await restoreViewportState(pairs,view,signal);
  positionAffixed(root,clone,view,scrollX,scrollY,pairs);
  const svg='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new view.XMLSerializer().serializeToString(tree));
  const image=new view.Image();
  await abortable(new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('A preview asset could not be rendered. Check image access and CSP.'));image.src=svg;}),signal);
  signal?.throwIfAborted();
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d');
  const background=view.getComputedStyle(root).backgroundColor,bodyBackground=view.getComputedStyle(document.body).backgroundColor;
  context.fillStyle=background!=='rgba(0, 0, 0, 0)'?background:bodyBackground!=='rgba(0, 0, 0, 0)'?bodyBackground:'#fff';context.fillRect(0,0,width,height);context.drawImage(image,0,0,width,height);
  return canvas;
}
function rounded(context,x,y,width,height,radius){context.beginPath();context.roundRect(x,y,width,height,radius);}
// This local, user-triggered export never sends pixels to the development
// sidecar, an assistant, telemetry or a remote screenshot service.
export async function exportPreviewPng({frame,model,signal}){
  const geometry=pngGeometry(model),source=await viewportCanvas(frame,signal);signal?.throwIfAborted();
  const canvas=frame.ownerDocument.createElement('canvas');canvas.width=geometry.width;canvas.height=geometry.height;
  const context=canvas.getContext('2d'),{left,top,width,height}=geometry;
  if(model.frameEnabled){
    const radius=model.device==='phone'?44:model.device==='tablet'?30:model.device==='duo'?32:12;
    rounded(context,.5,.5,width-1,height-1,radius);context.fillStyle=model.device==='duo'?'#121212':'#101010';context.fill();context.strokeStyle='#303030';context.lineWidth=1;context.stroke();
  }
  context.save();if(model.frameEnabled){rounded(context,left,top,model.width,model.height,model.innerRadius);context.clip();}context.drawImage(source,left,top);context.restore();
  if(model.frameEnabled){
    context.fillStyle='#333';
    if(model.device==='phone'){
      if(model.rotated){rounded(context,4,height/2-34,4,68,2);context.fill();rounded(context,width-8,height/2-42,4,84,2);context.fill();}
      else{rounded(context,width/2-34,4,68,4,2);context.fill();rounded(context,width/2-42,height-8,84,4,2);context.fill();}
    }else if(model.device==='tablet'){context.beginPath();context.arc(width/2,9,2,0,Math.PI*2);context.fill();}
    else if(model.device==='desktop'){for(let i=0;i<3;i++){context.beginPath();context.arc(15+i*13,16,3,0,Math.PI*2);context.fill();}}
    else if(model.device==='duo'&&model.folded){context.fillStyle='#030303';context.beginPath();context.arc(model.rotated?width-6.12:width-23.88,model.rotated?height-23.88:6.12,2.28,0,Math.PI*2);context.fill();}
  }
  try{signal?.throwIfAborted();const blob=await new Promise((resolve,reject)=>{try{canvas.toBlob(value=>value?resolve(value):reject(Error('The browser could not create the PNG.')),'image/png');}catch{reject(Error('An image or canvas does not allow PNG export.'));}});signal?.throwIfAborted();return blob;}
  finally{source.width=source.height=0;canvas.width=canvas.height=0;}
}
