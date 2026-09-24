import { loadPageInitialProps } from './pages-initial-props.mjs';

/** Error hooks use the same App delegation as ordinary legacy Pages. */
export async function errorInitialProps(Page, context, App, snapshot) {
  return (await loadPageInitialProps({ Page, App, context, routerSnapshot: snapshot })).props;
}
