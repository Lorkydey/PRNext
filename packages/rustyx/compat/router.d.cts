import type { ComponentType, ReactNode, ReactElement } from 'react';
export interface UrlObject {
  auth?: string | null;
  host?: string | null;
  hostname?: string | null;
  href?: string | null;
  path?: string | null;
  pathname?: string | null;
  port?: string | number | null;
  protocol?: string | null;
  slashes?: boolean | null;
  query?: string | Record<string, string | number | boolean | Array<string | number | boolean> | null | undefined> | null;
  search?: string | null;
  hash?: string | null;
}
export interface RouterSnapshot {
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
  domainLocales?: NonNullable<import('./index.js').NextConfig['i18n']>['domains'];
  isLocaleDomain?: boolean;
  pathname: string;
  query: Record<string, string | string[] | undefined>;
  asPath: string;
  isReady?: boolean;
  isFallback?: boolean;
  isPreview?: boolean;
  basePath?: string;
}
export interface RustyxRouter extends RouterSnapshot {
  route: string;
  isReady: boolean;
  isFallback: boolean;
  isPreview: boolean;
  basePath: string;
  push(url: string | UrlObject, as?: string | UrlObject, options?: { scroll?: boolean; shallow?: boolean; locale?: string | false }): Promise<boolean>;
  replace(url: string | UrlObject, as?: string | UrlObject, options?: { scroll?: boolean; shallow?: boolean; locale?: string | false }): Promise<boolean>;
  prefetch(url: string | UrlObject, as?: string | UrlObject, options?: { priority?: boolean; locale?: string | false }): Promise<void>;
  beforePopState(callback: (state: { url: string; as: string; options: { shallow?: boolean; scroll?: boolean } }) => boolean): void;
  events: RouterEvents;
  reload(): void;
  back(): void;
  forward(): void;
}
export type RouterEvent = 'routeChangeStart' | 'beforeHistoryChange' | 'routeChangeComplete' | 'routeChangeError' | 'hashChangeStart' | 'hashChangeComplete';
export interface RouterEvents {
  on(type: RouterEvent, callback: (...args: any[]) => void): void;
  off(type: RouterEvent, callback: (...args: any[]) => void): void;
  emit(type: RouterEvent, ...args: any[]): void;
}
export type NextRouter = RustyxRouter;
export function useRouter(): RustyxRouter;
export function RouterProvider(props: { router: RouterSnapshot; children?: ReactNode; managed?: boolean }): ReactElement;
export function withRouter<Props extends { router: RustyxRouter }>(Component: ComponentType<Props>): ComponentType<Omit<Props, 'router'>>;
export function formatUrl(url: string | UrlObject): string;
export function makeRouter(snapshot: RouterSnapshot): RustyxRouter;
declare const router: RustyxRouter;
export default router;
