import { localePath, withLocale } from '../compat/locale.cjs';
export { localizedStaticPaths } from '../runtime/pages-paths.mjs';

export function validateI18n(input) {
  if (input === undefined) return undefined;
  const fail = message => {throw new TypeError('i18n: '+message)};
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('expected an object');
  for (const key of Object.keys(input)) if (!['locales','defaultLocale','localeDetection','domains'].includes(key)) fail(`unknown option ${key}`);
  const {locales,defaultLocale,localeDetection=true,domains=[]}=input;
  if (!Array.isArray(locales)||!locales.length||locales.length>100||locales.some(value=>typeof value!=='string'||!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(value))) fail('locales must contain 1–100 locale identifiers');
  if (new Set(locales.map(value=>value.toLowerCase())).size!==locales.length) fail('duplicate locales');
  if (!locales.includes(defaultLocale)) fail('defaultLocale must belong to locales');
  if (typeof localeDetection!=='boolean') fail('localeDetection must be boolean');
  if (!Array.isArray(domains)||domains.length>100) fail('domains must contain at most 100 entries');
  const hosts=new Set(), defaults=new Set();
  for (const value of domains) {
    if (!value||typeof value!=='object'||Object.keys(value).some(key=>!['domain','defaultLocale','locales','http'].includes(key))) fail('invalid domain entry');
    if (typeof value.domain!=='string'||value.domain.length>256||!/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(value.domain)||hosts.has(value.domain.toLowerCase())) fail('invalid or duplicate domain');
    if (!locales.includes(value.defaultLocale)||defaults.has(value.defaultLocale)) fail('invalid or duplicate domain defaultLocale');
    if (value.http!==undefined&&typeof value.http!=='boolean') fail('domain http must be boolean');
    if (value.locales!==undefined&&(!Array.isArray(value.locales)||value.locales.length>100||value.locales.some(locale=>!locales.includes(locale)))) fail('domain locales must belong to locales');
    hosts.add(value.domain.toLowerCase());defaults.add(value.defaultLocale);
  }
  return {locales:[...locales],defaultLocale,localeDetection,domains};
}
export function expandLocales(manifest) {
  const i18n=manifest.config.i18n;
  if (!i18n) return;
  if (manifest.routes.length * i18n.locales.length > 100000) throw new Error('i18n route expansion exceeds 100000 routes');
  const occupied=new Set(manifest.routes.map(route=>route.pattern));
  manifest.routes=manifest.routes.flatMap(route=>{
    if(route.kind!=='page'||route.router==='app'||route.internal && !route.errorStatus && route.pattern !== '/_error') return [route];
    return i18n.locales.map(locale=>{
      const pattern=withLocale(route.pattern,locale,i18n.defaultLocale);
      if(locale!==i18n.defaultLocale&&occupied.has(pattern)) throw new Error(`i18n route conflicts with ${pattern}`);
      return {...route,pattern,locale,originalPattern:route.pattern,id:locale===i18n.defaultLocale?route.id:route.id+'-locale-'+locale};
    });
  });
}
