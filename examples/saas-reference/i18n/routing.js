import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['en', 'fr'],
  defaultLocale: 'en',
  localePrefix: 'always',
});

export function safeLocale(locale) {
  return routing.locales.includes(locale) ? locale : routing.defaultLocale;
}
