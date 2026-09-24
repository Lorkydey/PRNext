import type { CookieStore } from './headers.cjs';
export interface NextURLConfig { i18n?: import('./index.js').NextConfig['i18n']; basePath?: string; trailingSlash?: boolean; skipMiddlewareUrlNormalize?: boolean; skipProxyUrlNormalize?: boolean }
export class NextURL extends URL { constructor(input: string | URL, options?: { base?: string | URL; nextConfig?: NextURLConfig }); constructor(input: string | URL, base: string | URL, options?: { nextConfig?: NextURLConfig }); clone(): NextURL; locale: string; readonly defaultLocale?: string; readonly domainLocale?: NonNullable<NonNullable<import('./index.js').NextConfig['i18n']>['domains']>[number]; basePath: string; trailingSlash: boolean }
export class NextRequest extends Request { constructor(input: RequestInfo | URL, init?: RequestInit & { nextConfig?: NextURLConfig }); nextUrl: NextURL; cookies: CookieStore }
export interface MiddlewareResponseInit extends ResponseInit { request?: { headers?: Headers } }
export class NextResponse<Body = unknown> extends Response {
  cookies: CookieStore;
  static json<T>(body: T, init?: ResponseInit): NextResponse<T>;
  static redirect(url: string | URL, init?: number | ResponseInit): NextResponse;
  static next(init?: MiddlewareResponseInit): NextResponse;
  static rewrite(destination: string | URL, init?: MiddlewareResponseInit): NextResponse;
}
export interface NextFetchEvent {
  readonly sourcePage: string;
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  /** @deprecated Read the handler's first argument instead. */
  readonly request: never;
  /** @deprecated Return a Response from the handler instead. */
  respondWith(): never;
}
export type NextMiddlewareResult = NextResponse | Response | null | undefined | void;
export type NextMiddleware = (request: NextRequest, event: NextFetchEvent) => NextMiddlewareResult | Promise<NextMiddlewareResult>;
export type NextProxy = NextMiddleware;
export interface MiddlewareMatcher {
  source: string;
  locale?: false;
  has?: import('./index.d.ts').RouteCondition[];
  missing?: import('./index.d.ts').RouteCondition[];
}
export interface MiddlewareConfig {
  matcher?: string | Array<string | MiddlewareMatcher>;
  runtime?: 'nodejs' | 'edge' | 'experimental-edge';
}
export interface ProxyConfig { matcher?: MiddlewareConfig['matcher'] }
/** Exclude the following render from prerendering until a request is available. */
export function connection(): Promise<void>;
