import { getTranslations } from 'next-intl/server';
import { AuthForm } from '../../forms.jsx';
import { Link } from '../../../i18n/navigation.js';

export default async function SignUp({ params }) {
  const { locale } = await params, t = await getTranslations('App');
  return <main id="main"><h1>{t('signUp')}</h1><AuthForm locale={locale} mode="sign-up" />
    <p><Link href="/sign-in">{t('signIn')}</Link></p>
  </main>;
}
