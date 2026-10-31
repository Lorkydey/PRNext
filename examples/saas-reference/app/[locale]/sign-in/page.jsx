import { getTranslations } from 'next-intl/server';
import { AuthForm } from '../../forms.jsx';
import { signInOidc } from '../../actions.js';
import { Link } from '../../../i18n/navigation.js';

export default async function SignIn({ params }) {
  const { locale } = await params, t = await getTranslations('App');
  return <main id="main"><h1>{t('signIn')}</h1><AuthForm locale={locale} mode="sign-in" />
    {process.env.OIDC_ISSUER && <form action={signInOidc}><input type="hidden" name="locale" value={locale} /><button>{t('oidc')}</button></form>}
    <p><Link href="/sign-up">{t('signUp')}</Link></p>
  </main>;
}
