import Router, { useRouter, type NextRouter } from 'next/router';
import RustyxRouter from 'rustyx/router';
import Link from 'next/link';

const start = (url: string, options: { shallow: boolean }) => { void [url, options.shallow]; };
Router.events.on('routeChangeStart', start);
Router.events.off('routeChangeStart', start);
Router.beforePopState(({ url, as, options }) => Boolean(url || as || options.shallow));
void Router.push({ pathname: '/post/[slug]', query: { slug: 'typed', tags: ['one', 'two'] } }, undefined, { shallow: true, scroll: false });
void RustyxRouter.prefetch('/post/typed');
const pathname: string = Router.pathname;
void pathname;

function navigate(router: NextRouter) {
  router.events.on('routeChangeComplete', start);
  router.beforePopState(() => true);
  void router.replace('/post/typed', undefined, { shallow: false });
  // @ts-expect-error shallow is a boolean rather than a string.
  void router.push('/post/typed', undefined, { shallow: 'true' });
}

export function Navigation() {
  const router = useRouter();
  return <Link href={{ pathname: '/post/[slug]', query: { slug: 'typed' } }} shallow scroll={false}
    onNavigate={event => { if (!router.isReady) event.preventDefault(); }} onClick={() => navigate(router)}>Typed navigation</Link>;
}
