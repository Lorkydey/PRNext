'use client';
'use strict';
const { useEffect, useRef } = require('react');
const subscribers=new Set(),latest=new Map();
let observing=false;
function deliver(callback,metric){try{callback(metric)}catch(error){console.error('[prnext] Web Vitals callback failed:',error)}}
function publish(metric){latest.set(metric.name,metric);for(const callback of [...subscribers])deliver(callback,metric)}
function useReportWebVitals(report) {
  const current=useRef(report);
  useEffect(()=>{current.current=report},[report]);
  useEffect(() => {
    if(typeof report!=='function')throw new TypeError('useReportWebVitals expects a callback');
    const subscriber=metric=>current.current(metric);
    subscribers.add(subscriber);
    for(const metric of latest.values())deliver(subscriber,metric);
    if(!observing){const {onCLS,onLCP,onINP,onFCP,onTTFB}=require('web-vitals');observing=true;for (const observe of [onCLS, onLCP, onINP, onFCP, onTTFB]) observe(publish, { reportSoftNavs: true });}
    return()=>subscribers.delete(subscriber);
  }, []);
}
module.exports = { useReportWebVitals };
