import {workloadsFor} from './migration-load.mjs';
export const auditSites=['boutique','boutique-node','journal','dashboard','portail','documentation'];
export function auditMixed(name){
  if(name==='portail')return[{endpoint:'/',marker:'Un portail, toutes vos missions.',cookieNonce:'visitor'},{endpoint:'/recherche',marker:'Recherche Orion',queryNonce:'q'},{endpoint:'/api/echo',marker:'"service":"orion"',queryNonce:'q'},{endpoint:'/api/slow',marker:'orion-slow',queryNonce:'q'}];
  if(name==='documentation')return[{endpoint:'/',marker:'Le manuel de votre produit.'},{endpoint:'/guide/guide-42',marker:'Guide 42'},{endpoint:'/revision',marker:'Révision du manuel'},{endpoint:'/api/recherche',marker:'"results":',queryNonce:'q'}];
  return workloadsFor(name);
}
export function auditCases(name,inspection={}){
  const one=(id,label,workload)=>({id,label,workloads:[workload],kind:'route',concurrency:4});
  const cases=[];
  if(name.startsWith('boutique')){
    cases.push(one('static','Accueil App statique',{endpoint:'/',marker:'Des objets qui restent.'}));
    cases.push(one('runtime',name==='boutique'?'Page Edge SSR':'Même page Node pré-rendue',{endpoint:'/edge',marker:'Atelier Edge'}));
    if(name==='boutique'){
      cases.push(one('api-get','API App GET',{endpoint:'/api/catalogue',marker:'Lampe Aube'}),one('api-post','API App POST',{endpoint:'/api/catalogue',method:'POST',body:'{"sku":"lampe","quantity":2}',status:201,marker:'lampe'}));
      if(inspection.imageResponse?.src)cases.push(one('image-hot','Image optimisée déjà calculée',{endpoint:inspection.imageResponse.src,headers:{accept:'image/webp'},contentType:'image/webp',magicBase64:Buffer.from('RIFF').toString('base64'),minBytes:100}));
    }
  }else if(name==='journal'){
    cases.push(one('static','Accueil Pages multilingue',{endpoint:'/',marker:'Prendre le temps de regarder.'}),one('isr-hit','Page ISR déjà calculée',{endpoint:'/article/foret',marker:'Une nuit dans la forêt'}),one('ssr','Pages SSR personnalisé',{endpoint:'/recherche',marker:'Recherche',queryNonce:'q'}),one('api-pages','API Pages POST',{endpoint:'/api/contact',method:'POST',body:'{"email":"bench@example.test"}',status:201,marker:'"subscribed":"bench@example.test"'}));
  }else if(name==='dashboard'){
    cases.push(one('ppr-html','PPR HTML personnalisé',{endpoint:'/',marker:'Votre équipe, en mouvement.',cookieNonce:'visitor'}),one('ppr-flight','PPR Flight personnalisé',{endpoint:'/?_rsc=',marker:'Votre équipe, en mouvement.',cookieNonce:'visitor',headers:{RSC:'1'}}),one('api-session','API de session personnalisée',{endpoint:'/api/session',marker:'"visitor":',cookieNonce:'visitor'}),one('static','Route canonique statique',{endpoint:'/projet/atlas',marker:'Projet atlas'}));
  }else if(name==='portail'){
    cases.push(one('ssr','App SSR personnalisé',{endpoint:'/',marker:'Un portail, toutes vos missions.',cookieNonce:'visitor'}),one('ssr-search','App SSR avec liste',{endpoint:'/recherche',marker:'Recherche Orion',queryNonce:'q'}),one('api-fast','API App immédiate',{endpoint:'/api/echo',marker:'"service":"orion"',queryNonce:'q'}),one('api-async','API avec attente de 30 ms',{endpoint:'/api/slow',marker:'orion-slow',queryNonce:'q'}),one('stream','Streaming Suspense avec attente de 80 ms',{endpoint:'/stream',marker:'Flux terminé',cookieNonce:'visitor'}),one('proxy','Proxy puis SSR personnalisé',{endpoint:'/prive',marker:'Espace protégé',cookieNonce:'visitor',headers:{cookie:'access=yes'}}),one('export-gzip','Export JSON volumineux / gzip',{endpoint:'/api/export',marker:'orion-export',encoding:'gzip',minBytes:100000}));
  }else if(name==='documentation'){
    cases.push(one('static-large','Longue page Pages statique',{endpoint:'/guide/guide-42',marker:'Guide 42',minBytes:30000}),one('static-gzip','Longue page statique / gzip',{endpoint:'/guide/guide-42',marker:'Guide 42',encoding:'gzip',minBytes:30000}),one('public-gzip','Fichier public / gzip',{endpoint:'/manual.txt',marker:'MANUEL BOREAL',encoding:'gzip',minBytes:200000}),one('isr-hit','Page ISR déjà calculée',{endpoint:'/revision',marker:'Révision du manuel'}),one('api-pages','API Pages GET',{endpoint:'/api/recherche',marker:'"results":',queryNonce:'q'}));
  }
  if(name==='portail')cases.push(one('export-identity','Export JSON volumineux sans compression',{endpoint:'/api/export',marker:'orion-export',encoding:'identity',minBytes:100000}));
  if(name==='documentation')cases.push({id:'static-rotation',label:'Rotation sur les 100 pages SSG',kind:'route',concurrency:4,workloads:Array.from({length:100},(_,index)=>({endpoint:'/guide/guide-'+index,marker:'Guide '+index,minBytes:30000}))});
  cases.push({id:'mixed',label:'Parcours mixte du projet',workloads:auditMixed(name),kind:'mixed',concurrency:4});
  return cases;
}
