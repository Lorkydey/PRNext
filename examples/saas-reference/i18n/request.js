import { getRequestConfig } from 'next-intl/server';
import { safeLocale } from './routing.js';
import { messages } from './messages.js';

export default getRequestConfig(async ({ requestLocale }) => {
  const locale = safeLocale(await requestLocale);
  return { locale, messages: messages[locale], timeZone: 'UTC' };
});
