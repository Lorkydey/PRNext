import App, { type AppContext, type AppInitialProps, type AppProps } from 'next/app';
import RustyxApp from 'rustyx/app';
import type { NextPage, NextPageContext } from 'rustyx';

const Page: NextPage<{ value: string }> = ({ value }) => <p>{value}</p>;
Page.getInitialProps = async (ctx: NextPageContext) => {
  ctx.res?.setHeader('x-initial-props', 'yes');
  return { value: ctx.query.value?.toString() || ctx.pathname };
};
class CustomApp extends App<{ locale: string }> {
  static async getInitialProps(context: AppContext): Promise<AppInitialProps & { locale: string }> {
    const data = await App.getInitialProps(context);
    const tree = <context.AppTree {...data}/>;
    const pathname: string = context.router.pathname;
    void [tree, pathname];
    return { ...data, locale: 'fr' };
  }
  render() {
    return <div lang={this.props.locale}>{super.render()}</div>;
  }
}
const FunctionApp = ({ Component, pageProps }: AppProps<{ value: string }>) => <Component {...pageProps}/>;
const defaultApp: typeof App = RustyxApp;
void [Page, CustomApp, FunctionApp, defaultApp];

// @ts-expect-error App hooks receive the wrapped Page context and Component.
App.getInitialProps({ pathname: '/' });
