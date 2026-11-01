import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { Link } from '../../i18n/navigation.js';
import { routing } from '../../i18n/routing.js';

export default async function LocaleLayout({ children, params }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('App');
  return <NextIntlClientProvider locale={locale} messages={await getMessages()} timeZone="UTC">
    <header><Link href="/" className="brand">PRNext workspace</Link><nav aria-label={t('home')}>
      <Link href="/dashboard">{t('dashboard')}</Link>
      <Link href="/" locale="fr" lang="fr" hrefLang="fr">Français</Link>
      <Link href="/" locale="en" lang="en" hrefLang="en">English</Link>
    </nav></header>{children}
  </NextIntlClientProvider>;
}
