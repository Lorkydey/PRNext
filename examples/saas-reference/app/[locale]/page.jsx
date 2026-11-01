import { getTranslations } from 'next-intl/server';
import { Link } from '../../i18n/navigation.js';

export default async function Home() {
  const t = await getTranslations('App');
  return <main id="main"><h1>{t('welcome')}</h1><p>{t('detail')}</p>
    <div className="actions"><Link className="button" href="/sign-in">{t('signIn')}</Link>
      <Link href="/sign-up">{t('signUp')}</Link></div>
  </main>;
}
