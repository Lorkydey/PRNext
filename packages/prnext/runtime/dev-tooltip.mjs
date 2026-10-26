// One tooltip per workbench, rendered above modal clipping in its own window.
let sequence = 0;
export function createDevTooltips(shadow) {
  const document=shadow.ownerDocument,view=document.defaultView;
  const controller=new view.AbortController(),events={signal:controller.signal};
  const tooltip=document.createElement('div'),label=document.createElement('span'),detail=document.createElement('span');
  tooltip.className='wb wb-tooltip';tooltip.id=`prnext-dev-tooltip-${++sequence}`;tooltip.popover='manual';tooltip.setAttribute('role','tooltip');
  label.className='wb-tooltip-label';detail.className='wb-tooltip-detail';tooltip.append(label,detail);shadow.append(tooltip);
  let owner,pending,suppressed,hovered,focused,showTimer,hideTimer,exitTimer,lastShown=-Infinity;
  const target=event=>event.composedPath().find(node=>node?.hasAttribute?.('data-wb-tooltip'));
  const contains=(node,other)=>other instanceof view.Node&&node.contains(other);
  function clearTimers(){view.clearTimeout(showTimer);view.clearTimeout(hideTimer);view.clearTimeout(exitTimer);}
  function describe(node,enabled){
    const ids=new Set((node.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean));
    if(enabled)ids.add(tooltip.id);else ids.delete(tooltip.id);
    if(ids.size)node.setAttribute('aria-describedby',[...ids].join(' '));else node.removeAttribute('aria-describedby');
  }
  function hide({immediate=false}={}){
    clearTimers();pending=undefined;if(owner)describe(owner,false);owner=undefined;tooltip.dataset.open='false';
    const close=()=>{if(tooltip.matches(':popover-open'))tooltip.hidePopover();};
    if(immediate||view.matchMedia('(prefers-reduced-motion: reduce)').matches)close();else exitTimer=view.setTimeout(close,100);
  }
  function position(node){
    const anchor=node.getBoundingClientRect(),margin=8,gap=8;
    const viewport=view.visualViewport,width=viewport?.width||view.innerWidth,height=viewport?.height||view.innerHeight;
    tooltip.style.maxWidth=Math.max(1,width-2*margin)+'px';
    const bounds=tooltip.getBoundingClientRect();
    const leftEdge=viewport?.offsetLeft||0,topEdge=viewport?.offsetTop||0;
    const below=anchor.bottom+gap,bottom=topEdge+height-margin;
    const top=below+bounds.height<=bottom?below:Math.max(topEdge+margin,anchor.top-gap-bounds.height);
    tooltip.dataset.side=top>=anchor.bottom?'bottom':'top';
    tooltip.style.left=Math.max(leftEdge+margin,Math.min(anchor.x+(anchor.width-bounds.width)/2,leftEdge+width-margin-bounds.width))+'px';
    tooltip.style.top=top+'px';
  }
  function show(node){
    pending=undefined;
    if(!node.isConnected||node===suppressed||!node.getClientRects().length)return;
    clearTimers();if(owner&&owner!==node)describe(owner,false);owner=node;
    label.textContent=node.dataset.wbTooltip;detail.textContent=node.dataset.wbTooltipDetail||'';detail.hidden=!detail.textContent;
    // Keep the popover in the active dialog's non-inert subtree.
    const container=node.closest('dialog')||shadow;if(tooltip.parentNode!==container)container.append(tooltip);
    if(!tooltip.matches(':popover-open')){
      tooltip.dataset.open='false';try{tooltip.showPopover();}catch{owner=undefined;return;}
    }
    position(node);tooltip.getBoundingClientRect();tooltip.dataset.open='true';describe(node,true);lastShown=view.performance.now();
  }
  function schedule(node,keyboard=false){
    if(!node||node===suppressed)return;
    view.clearTimeout(hideTimer);view.clearTimeout(exitTimer);
    if(node===owner){tooltip.dataset.open='true';return;}
    view.clearTimeout(showTimer);pending=node;
    const warm=tooltip.matches(':popover-open')||view.performance.now()-lastShown<600;
    showTimer=view.setTimeout(()=>show(node),keyboard||warm?60:280);
  }
  function maybeHide(node){
    if(node===hovered||node===focused)return;
    if(suppressed===node)suppressed=undefined;
    if(node===pending){view.clearTimeout(showTimer);pending=undefined;}
    if(node===owner){const next=[hovered,focused].find(value=>value&&value!==suppressed);if(next)schedule(next,next===focused);else hideTimer=view.setTimeout(()=>hide(),120);}
  }
  shadow.addEventListener('pointerover',event=>{const node=target(event);if(node&&event.pointerType!=='touch'){hovered=node;schedule(node);}},events);
  shadow.addEventListener('pointerout',event=>{const node=target(event);if(!node||contains(node,event.relatedTarget)||contains(tooltip,event.relatedTarget))return;if(hovered===node)hovered=undefined;maybeHide(node);},events);
  shadow.addEventListener('focusin',event=>{const node=target(event);if(node?.matches(':focus-visible')){focused=node;schedule(node,true);}},events);
  shadow.addEventListener('focusout',event=>{const node=target(event);if(!node||contains(node,event.relatedTarget))return;if(focused===node)focused=undefined;maybeHide(node);},events);
  tooltip.addEventListener('pointerenter',()=>view.clearTimeout(hideTimer),events);
  tooltip.addEventListener('pointerleave',event=>{if(owner&&contains(owner,event.relatedTarget))return;const node=hovered;hovered=undefined;if(node)maybeHide(node);},events);
  const dismiss=event=>{const node=target(event);if(node)suppressed=node;if(event.type==='pointerdown')focused=undefined;hide({immediate:true});};
  shadow.addEventListener('pointerdown',dismiss,{...events,capture:true});
  shadow.addEventListener('click',dismiss,{...events,capture:true});
  shadow.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&(owner||pending)){
      const path=event.composedPath();
      const consume=[owner,pending].some(node=>{
        if(!node)return false;
        const modal=node.closest('dialog[open]');
        return path.includes(node)||Boolean(modal&&path.includes(modal));
      });
      // A hovered control must not steal Escape from another focused control
      // in the nonmodal console. Native modals retain tooltip-first dismissal.
      suppressed=owner||pending;hide({immediate:true});
      if(consume){event.preventDefault();event.stopPropagation();}
    }
  },{...events,capture:true});
  const dismissLayout=()=>hide({immediate:true});
  view.addEventListener('resize',dismissLayout,events);view.addEventListener('blur',dismissLayout,events);
  view.addEventListener('scroll',dismissLayout,{...events,capture:true});
  view.visualViewport?.addEventListener('resize',dismissLayout,events);
  view.visualViewport?.addEventListener('scroll',dismissLayout,events);
  return{
    set(node,text,description=''){node.dataset.wbTooltip=text;node.dataset.wbTooltipDetail=description;node.removeAttribute('title');if(owner===node)show(node);return node;},
    hide:()=>hide({immediate:true}),
    dispose(){hide({immediate:true});controller.abort();tooltip.remove();},
  };
}
