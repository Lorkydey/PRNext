import { Component, type ComponentType, type ReactElement, type ReactNode, type HTMLAttributes, type HtmlHTMLAttributes } from 'react';
import type { AppProps, NextPageContext } from './index.d.ts';

export type Enhancer<C> = (Component: C) => C;
export type ComponentsEnhancer = {
  enhanceApp?: Enhancer<ComponentType<AppProps<any>>>;
  enhanceComponent?: Enhancer<ComponentType<any>>;
} | Enhancer<ComponentType<any>>;
export interface RenderPageResult { html: string; head?: Array<ReactElement | null> }
export interface DocumentInitialProps extends RenderPageResult {
  styles?: ReactElement[] | Iterable<ReactNode> | ReactElement;
}
export type RenderPage = (options?: ComponentsEnhancer) => DocumentInitialProps | Promise<DocumentInitialProps>;
export interface DocumentContext extends NextPageContext {
  renderPage: RenderPage;
  defaultGetInitialProps(context: DocumentContext, options?: { nonce?: string }): Promise<DocumentInitialProps>;
}
export interface DocumentProps extends DocumentInitialProps {
  __NEXT_DATA__: { props: { pageProps: any }; page: string; query: NextPageContext['query']; buildId?: string; assetPrefix?: string; isFallback?: boolean; gsp?: boolean; gssp?: boolean };
  assetPrefix: string;
  dangerousAsPath: string;
  isDevelopment: boolean;
  nonce?: string;
  crossOrigin?: 'anonymous' | 'use-credentials' | '';
}
export interface OriginProps { nonce?: string; crossOrigin?: 'anonymous' | 'use-credentials' | ''; children?: ReactNode }
export function Html(props: HtmlHTMLAttributes<HTMLHtmlElement>): ReactElement;
export class Head extends Component<OriginProps & HTMLAttributes<HTMLHeadElement>> {
  getCssLinks(): ReactElement[];
  getScripts(): ReactElement[];
  render(): ReactElement;
}
export function Main(): ReactElement;
export class NextScript extends Component<OriginProps> {
  static getInlineScriptSource(context: Readonly<{ __NEXT_DATA__: DocumentProps['__NEXT_DATA__'] }>): string;
  render(): ReactElement;
}
export default class Document<Props = {}> extends Component<DocumentProps & Props> {
  static getInitialProps(context: DocumentContext): Promise<DocumentInitialProps>;
  render(): ReactElement;
}
