import createNextIntlPlugin from 'next-intl/plugin';

export default createNextIntlPlugin('./i18n/request.js')({
  output: 'standalone',
  server: { publicOrigin: process.env.BETTER_AUTH_URL },
  serverExternalPackages: ['pg'],
  transpilePackages: ['next-intl', 'better-auth'],
  navigationCache: { authCookies: ['better-auth.session_token', '__Secure-better-auth.session_token'] },
});
