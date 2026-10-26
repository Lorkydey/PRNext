// Images are MCP image blocks, never base64 text in the model's text context.
// Browser HTTP snapshots retain the original image for the local inspector.
export function devToolResult(value) {
  const copy=structuredClone(value),data=copy&&typeof copy==='object'&&!Array.isArray(copy)?copy:{value:copy??null},images=[],candidates=[];
  // Walk JSON iteratively, so deeply nested CLI replies cannot overflow the
  // formatter stack. All image data is removed from text, even malformed data.
  const stack=[data];
  while(stack.length){
    const parent=stack.pop();if(!parent||typeof parent!=='object')continue;
    const entries=Object.entries(parent);
    for(let index=entries.length-1;index>=0;index--){
      const [key,item]=entries[index];
      if(key==='screenshot'&&(typeof item==='string'||item&&typeof item==='object'&&Object.hasOwn(item,'data'))||
        item&&typeof item==='object'&&typeof item.mimeType==='string'&&item.mimeType.startsWith('image/')&&Object.hasOwn(item,'data')){
        candidates.push({parent,key,image:item});continue;
      }
      if(item&&typeof item==='object')stack.push(item);
    }
  }
  // The traversal above retains chronological context array order. Prefer its
  // most recent valid image; older/invalid images remain explicit omissions.
  let selected;
  for(const candidate of candidates){
    const image=candidate.image;
    const valid=image?.mimeType==='image/png'&&typeof image.data==='string'&&image.data.length<=350000&&/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)&&
      Buffer.from(image.data,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    candidate.valid=valid;if(valid)selected=candidate;
  }
  for(const candidate of candidates){
    const {parent,key,image,valid}=candidate;
    if(candidate===selected){
      images.push({type:'image',mimeType:'image/png',data:image.data});
      parent[key]={mimeType:'image/png',width:image.width,height:image.height,attached:true};
    }else parent[key]={omitted:true,reason:valid?'Only the latest screenshot is attached.':'Screenshot is invalid, unsupported or exceeds the image limit.'};
  }
  return {content:[{type:'text',text:JSON.stringify(data)},...images],structuredContent:data,isError:false};
}
