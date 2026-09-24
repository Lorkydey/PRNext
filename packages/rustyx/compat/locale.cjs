'use strict';
function localePath(pathname, i18n) {
  if (!i18n) return { pathname, locale: undefined };
  const first = pathname.split(/[/?#]/)[1];
  const locale = i18n.locales.find(value => value.toLowerCase() === first?.toLowerCase());
  const rest = locale ? pathname.slice(first.length + 1) : pathname;
  return { pathname: rest.startsWith('/') ? rest : '/' + rest, locale: locale || i18n.defaultLocale };
}
function withLocale(pathname, locale, defaultLocale) {
  return !locale || locale === defaultLocale ? pathname : '/' + locale + (pathname === '/' ? '' : pathname);
}
function localizedHref(href, router, selected) {
  if (!router?.i18n || selected === false || !href.startsWith('/') || href.startsWith('//')) return href;
  const i18n = router.i18n;
  const locale = selected || router.locale || i18n.defaultLocale;
  if (!i18n.locales.includes(locale)) throw new Error(`Unknown locale: ${locale}`);
  const url = new URL(href, 'http://rustyx.local');
  const base = router.basePath || '';
  if (base && (url.pathname === base || url.pathname.startsWith(base + '/'))) url.pathname = url.pathname.slice(base.length) || '/';
  const parsed = localePath(url.pathname, i18n);
  const explicit = parsed.pathname !== url.pathname;
  const chosen = selected || (explicit ? parsed.locale : locale);
  const domain = i18n.domains?.find(value => value.defaultLocale === chosen || value.locales?.includes(chosen));
  const host = router.domain;
  const current = i18n.domains?.find(value => value.domain.toLowerCase() === host?.toLowerCase());
  const prefix = domain && current && domain.domain !== current.domain ? `${domain.http ? 'http' : 'https'}://${domain.domain}` : '';
  const defaultLocale = (prefix ? domain?.defaultLocale : current?.defaultLocale) || router.defaultLocale || i18n.defaultLocale;
  return prefix + base + withLocale(parsed.pathname, chosen, defaultLocale) + url.search + url.hash;
}
module.exports = { localePath, withLocale, localizedHref };
