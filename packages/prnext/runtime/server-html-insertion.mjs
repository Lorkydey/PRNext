import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ServerInsertedHTMLContext} from '../compat/server-inserted-html.cjs';
import {MAX_RESPONSE_BYTES} from './http.mjs';

// Every response owns its callbacks and CSS registry. Flush at HTML boundaries
// so suspended components can insert styles without buffering the whole page.
export async function createServerHtmlInsertion({styledJsx=false,nonce}={}) {
  const callbacks=new Set();
  let registry,StyleRegistry;
  if(styledJsx){const jsx=(await import('../compat/styled-jsx.cjs')).default;StyleRegistry=jsx.StyleRegistry;registry=jsx.createStyleRegistry();}
  const collect=()=>{
    const nodes=[...callbacks].map(callback=>callback());
    if(registry){nodes.push(...registry.styles({nonce}));registry.flush();}
    return nodes;
  };
  return {
    collect,
    wrap(content){
      if(registry)content=React.createElement(StyleRegistry,{registry},content);
      return React.createElement(ServerInsertedHTMLContext.Provider,{value:callback=>callbacks.add(callback)},content);
    },
    flush(){
      const nodes=collect();
      if(!nodes.length)return '';
      const html=renderToStaticMarkup(React.createElement(React.Fragment,null,...nodes));
      if(Buffer.byteLength(html)>MAX_RESPONSE_BYTES)throw Object.assign(new Error('Inserted HTML exceeds the 16 MiB PRNext limit'),{code:'PRNEXT_RESPONSE_TOO_LARGE'});
      return html;
    },
  };
}
