import { getLocale, getTranslations } from 'next-intl/server';
import './style.css';

export const dynamic = 'force-dynamic';
export default async function RootLayout({ children }) {
  const locale = await getLocale();
  const t = await getTranslations('App');
  return <html lang={locale}><body><a className="skip" href="#main">{t('skip')}</a>{children}</body></html>;
}
