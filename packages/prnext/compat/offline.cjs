'use client';
'use strict';
const React=require('react'),store=require('./offline-store.cjs');
function useOffline(){return React.useSyncExternalStore(store.subscribe,store.snapshot,()=>false);}
module.exports={useOffline};
