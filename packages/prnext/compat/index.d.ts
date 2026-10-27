/// <reference path="./fetch.d.cts" />
import type { ComponentType } from 'react';
import type { IncomingMessage, ServerResponse } from 'node:http';
export type { Metadata, Viewport, ResolvingMetadata, ResolvingViewport, MetadataRoute } from './metadata.cjs';
export {route} from './typed-route.cjs';
export type {Route, RoutePattern, RouteParameters} from './typed-route.cjs';

export interface InstantSample {
  cookies?: Array<{name: string; value: string | null}>;
  headers?: Array<[string, string | null]>;
  params?: Record<string, string | string[]>;
  searchParams?: Record<string, string | string[] | null>;
}
export type InstantConfig = boolean | { level?: 'warning' | 'experimental-error'; unstable_samples?: InstantSample[]; unstable_disableValidation?: true; unstable_disableDevValidation?: true; unstable_disableBuildValidation?: true };

export interface ReactCompilerOptions {
  compilationMode?: 'infer' | 'annotation';
  panicThreshold?: 'none' | 'critical_errors' | 'all_errors';
  /** PRNext requires matching React 19 peers. */
  target?: '19';
}

export type TurbopackCondition = 'browser' | 'foreign' | 'development' | 'production' | 'node' | 'edge-light'
  | {all: TurbopackCondition[]} | {any: TurbopackCondition[]} | {not: TurbopackCondition}
  | {path: string | RegExp; content?: RegExp} | {path?: string | RegExp; content: RegExp};
export interface TurbopackRule {
  loaders: Array<string | {loader: string; options?: Record<string, unknown>}>;
  as?: '*.js' | '*.jsx';
  condition?: TurbopackCondition;
}

export type PreviewData = string | false | object | undefined;
export type ParsedUrlQuery = Record<string, string | string[] | undefined>;
export type Redirect = ({ destination: string; permanent: boolean; statusCode?: never } | { destination: string; statusCode: 301 | 302 | 303 | 307 | 308; permanent?: never }) & { basePath?: false };
export type DataResult<Props> = { props: Props | Promise<Props> } | { notFound: true } | { redirect: Redirect };
export interface LocaleInfo { locale?: string; locales?: string[]; defaultLocale?: string; }
export interface GetServerSidePropsContext<Params extends ParsedUrlQuery = ParsedUrlQuery> extends LocaleInfo {
  req: IncomingMessage & { cookies: Record<string, string>; query: ParsedUrlQuery };
  res: ServerResponse;
  params?: Params;
  query: ParsedUrlQuery;
  resolvedUrl: string;
  preview: boolean;
  previewData?: PreviewData;
  draftMode: boolean;
}
export type GetServerSideProps<Props extends Record<string, unknown> = Record<string, unknown>, Params extends ParsedUrlQuery = ParsedUrlQuery> = (context: GetServerSidePropsContext<Params>) => Promise<DataResult<Props>> | DataResult<Props>;
export interface GetStaticPropsContext<Params extends ParsedUrlQuery = ParsedUrlQuery> extends LocaleInfo {
  params?: Params;
  preview: boolean;
  previewData?: PreviewData;
  draftMode: boolean;
  revalidateReason: 'build' | 'stale' | 'on-demand';
}
export type GetStaticProps<Props extends Record<string, unknown> = Record<string, unknown>, Params extends ParsedUrlQuery = ParsedUrlQuery> = (context: GetStaticPropsContext<Params>) => Promise<DataResult<Props> & { revalidate?: number | false }> | (DataResult<Props> & { revalidate?: number | false });
export type GetStaticPaths<Params extends ParsedUrlQuery = ParsedUrlQuery> = (context: {locales?: string[]; defaultLocale?: string}) => Promise<{ paths: Array<string | { params: Params; locale?: string }>; fallback: boolean | 'blocking' }> | { paths: Array<string | { params: Params; locale?: string }>; fallback: boolean | 'blocking' };
export type InferGetServerSidePropsType<T extends (...args: any[]) => any> = Awaited<Extract<Awaited<ReturnType<T>>, { props: any }>['props']>;
export type InferGetStaticPropsType<T extends (...args: any[]) => any> = InferGetServerSidePropsType<T>;
export interface NextApiRequest extends IncomingMessage {
  query: ParsedUrlQuery;
  cookies: Record<string, string>;
  body: any;
  draftMode: boolean;
  preview: boolean;
  previewData?: PreviewData;
}
/** Pages API responses can stream; socket upgrades are not implemented. */
export type NextApiResponse<T = any> = Pick<ServerResponse, 'statusCode' | 'statusMessage' | 'headersSent' | 'getHeader' | 'getHeaders' | 'getHeaderNames' | 'hasHeader' | 'removeHeader' | 'write' | 'end' | 'on' | 'once' | 'writableEnded'> & {
  setHeader(name: string, value: number | string | readonly string[]): NextApiResponse<T>;
  appendHeader(name: string, value: string | readonly string[]): NextApiResponse<T>;
  writeHead(statusCode: number, headers?: import('node:http').OutgoingHttpHeaders): NextApiResponse<T>;
  writeHead(statusCode: number, statusMessage?: string, headers?: import('node:http').OutgoingHttpHeaders): NextApiResponse<T>;
  status(statusCode: number): NextApiResponse<T>;
  json(body: T): void;
  send(body: T | string | Buffer | Uint8Array): void;
  redirect(destination: string): void;
  redirect(statusCode: number, destination: string): void;
  revalidate(path: string, options?: { unstable_onlyGenerated?: boolean }): Promise<void>;
  setPreviewData(data: PreviewData, options?: { maxAge?: number; path?: string }): NextApiResponse<T>;
  setDraftMode(options: { enable: boolean }): NextApiResponse<T>;
  clearPreviewData(options?: { path?: string }): NextApiResponse<T>;
};
export type NextApiHandler<T = any> = (req: NextApiRequest, res: NextApiResponse<T>) => void | Promise<void>;
export interface NextPageContext extends LocaleInfo {
  err?: (Error & { statusCode?: number }) | null;
  req?: IncomingMessage;
  res?: ServerResponse;
  pathname: string;
  query: ParsedUrlQuery;
  asPath?: string;
  AppTree: ComponentType<AppInitialProps & Record<string, any>>;
}
export type NextPage<Props = Record<string, never>, InitialProps = Props> = ComponentType<Props> & {
  getInitialProps?(context: NextPageContext): InitialProps | Promise<InitialProps>;
};
export interface AppProps<Props = Record<string, unknown>> {
  Component: NextPage<Props, any>;
  pageProps: Props;
  router: import('./router.cjs').PRNextRouter;
}
export interface AppInitialProps<Props = any> { pageProps: Props }
export interface AppContext {
  Component: NextPage<any, any>;
  router: import('./router.cjs').PRNextRouter;
  ctx: NextPageContext;
  AppTree: ComponentType<any>;
}
export type AppType<Props = {}> = ComponentType<AppProps<any> & Props> & {
  getInitialProps?(context: AppContext): AppInitialProps & Props | Promise<AppInitialProps & Props>;
};
export type RouteCondition = { type: 'header' | 'cookie' | 'query'; key: string; value?: string } | { type: 'host'; value: string; key?: never };
export interface CustomRoute {
  source: string;
  has?: RouteCondition[];
  missing?: RouteCondition[];
  basePath?: false;
  locale?: false;
}
export interface Header extends CustomRoute { headers: Array<{ key: string; value: string }> }
export interface Rewrite extends CustomRoute { destination: string }
export type ConfigRedirect = CustomRoute & Redirect;
/** Implemented project options. Unsupported behavior-changing options fail the build. */
export interface NextConfig {
  /** PRNext only. CLI > environment > build configuration > profile.
   * 0 disables the corresponding retirement; keepWarm retains one lane per used host.
   */
  workerRetirement?: { idleSeconds?: number; laneIdleSeconds?: number; keepWarm?: boolean };
  /** Import selected Node routes on startup; top-level module code executes. RSS is a soft import budget. */
  workerPreload?: false | { routes: string[]; maxRssMb?: number; timeoutMs?: number };
  /** Keep bounded previous public hashed assets. false disables carry-over. Defaults: one hour, two generations, 64 MiB. */
  deploymentRetention?: false | {maxAge?: number; maxGenerations?: number; maxBytes?: number};
  /** Bounded active development routes; default retains five requested routes. */
  onDemandEntries?: { maxInactiveAge?: number; pagesBufferLength?: number };
  /** PRNext development menu; bottom-left by default. false hides it without disabling errors or Fast Refresh. */
  devIndicators?: false | { position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' };
  i18n?: { locales: string[]; defaultLocale: string; localeDetection?: boolean; domains?: Array<{domain: string; defaultLocale: string; locales?: string[]; http?: boolean}> };
  webpack?: (config: import('webpack').Configuration, context: { buildId: string; dev: boolean; isServer: boolean; nextRuntime?: 'nodejs' | 'edge'; webpack: typeof import('webpack'); defaultLoaders: {babel: {loader: string}} }) => import('webpack').Configuration | Promise<import('webpack').Configuration>;
  turbopack?: { root?: string; rules?: Record<string, TurbopackRule | TurbopackRule[]>; resolveAlias?: Record<string, string | { browser: string }>; resolveExtensions?: string[] };
  images?: import('./image.cjs').ImageConfig;
  pageExtensions?: string[];
  reactStrictMode?: boolean;
  /** Opt in to the bundled official React Compiler for application components. Disabled by default. */
  reactCompiler?: boolean | ReactCompilerOptions;
  /** Generate route completions and validate Link/router destinations. */
  typedRoutes?: boolean;
  /** Native CSS for default styles; custom PostCSS pipelines remain authoritative. */
  cssEngine?: 'auto'|'postcss'|'lightningcss';
  /** Production checks use the project's installed TypeScript without emitting files. */
  typescript?: { ignoreBuildErrors?: boolean; tsconfigPath?: string; devChecks?: boolean };
  cacheComponents?: boolean;
  cacheLife?: Record<string, import('./cache.cjs').CacheLife>;
  transpilePackages?: string[];
  serverExternalPackages?: string[];
  sassOptions?: {
    additionalData?: string | ((source: string, context: { resourcePath: string; rootContext: string }) => string | Promise<string>);
    includePaths?: string[];
    loadPaths?: string[];
    implementation?: 'sass' | 'sass-embedded';
    [option: string]: unknown;
  };
  experimental?: { nextScriptWorkers?: boolean; optimizePackageImports?: string[]; proxyClientMaxBodySize?: number | string; serverActions?: true | { allowedOrigins?: string[]; bodySizeLimit?: number | string } };
  trailingSlash?: boolean;
  skipTrailingSlashRedirect?: boolean;
  skipMiddlewareUrlNormalize?: boolean;
  skipProxyUrlNormalize?: boolean;
  cacheHandlers?: Record<string, string | undefined>;
  cacheHandler?: string;
  cacheMaxMemorySize?: number;
  distDir?: string;
  output?: 'standalone' | 'export';
  outputFileTracingRoot?: string;
  outputFileTracingIncludes?: Record<string, string[]>;
  outputFileTracingExcludes?: Record<string, string[]>;
  basePath?: string;
  assetPrefix?: string;
  env?: Record<string, string | undefined>;
  compress?: boolean;
  poweredByHeader?: boolean;
  productionBrowserSourceMaps?: boolean;
  generateBuildId?: () => string | null | Promise<string | null>;
  headers?: () => Header[] | Promise<Header[]>;
  redirects?: () => ConfigRedirect[] | Promise<ConfigRedirect[]>;
  rewrites?: () => Rewrite[] | { beforeFiles?: Rewrite[]; afterFiles?: Rewrite[]; fallback?: Rewrite[] } | Promise<Rewrite[] | { beforeFiles?: Rewrite[]; afterFiles?: Rewrite[]; fallback?: Rewrite[] }>;
}
export type PRNextConfig = NextConfig;
/** Public build envelope; internal manifest fields are adapter-specific. */
export type BuildOutput = {
  version: 1;
  buildId: string;
  manifest: 'manifest.json';
} & ({
  adapter: 'react';
  assets: 'assets';
  server: { entry: 'runtime/worker.mjs'; runtimeContract: 'runtime-contract.json' };
  fallback: null;
} | {
  adapter: 'static';
  assets: 'static';
  server: null;
  fallback: null | 'index.html';
});
export interface StaticBuildOptions {
  from?: string;
  spa?: boolean;
  distDir?: string;
  dev?: false;
}
export interface ReactCompilerReport {
  version: 1;
  compilerVersion: string | null;
  enabled: boolean;
  buildId: string | null;
  mode: 'development' | 'production';
  /** Incremental graphs can reuse inputs without observing their transforms. */
  scope: 'observed-transforms';
  options: boolean | ReactCompilerOptions | null;
  truncated: boolean;
  summary: {files: number; functions: number; optimized: number; skipped: number; errors: number; diagnostics: number; mixed: number; transforms: number; cacheReuses: number};
  files: Array<{
    file: string; transforms: number; cacheReuses: number; targets: string[]; notes: string[];
    functions: Array<{
      name: string | null;
      start: {line: number; column: number} | null;
      end: {line: number; column: number} | null;
      status: 'optimized' | 'skipped' | 'error' | 'diagnostic' | 'mixed';
      targets: string[];
      events: Array<{
        kind: 'CompileSuccess' | 'CompileSkip' | 'CompileError' | 'CompileDiagnostic' | 'PipelineError';
        status: 'optimized' | 'skipped' | 'error' | 'diagnostic' | 'mixed';
        reason: string | null; category: string | null; targets: string[]; policy?: boolean;
        memoSlots?: number; memoBlocks?: number; memoValues?: number;
      }>;
    }>;
  }>;
  graphs: Array<{target: string; metadataAvailable: boolean; projectJavaScriptInputs: number; observedFiles: number; unobservedInputs: number}>;
}
export interface CompilationCacheReport {
  version: 1;
  scope: 'eligible-production-compilation-graphs';
  hits: number;
  misses: number;
  bypasses: number;
  reusedBytes: number;
  kinds: Array<{kind: string; hits: number; misses: number; bypasses: number; writes: number; reusedBytes: number; reasons: Record<string, number>}>;
}
export interface BuildResult { buildId: string; outputDirectory: string; reactCompilerReport?: ReactCompilerReport; compilationCache?: CompilationCacheReport; }
export interface ProductionBuilder {
  build(options?: {envMode?: 'production' | 'test'}): Promise<BuildResult>;
  stats(): {contexts: number; created: number; reused: number};
  dispose(): Promise<void>;
}
export function createBuilder(projectRoot: string, options?: {envMode?: 'production' | 'test'}): Promise<ProductionBuilder>;
export interface StaticBuildResult extends BuildResult { files: number; bytes: number; }
export function build(projectRoot: string, options: StaticBuildOptions & { adapter: 'static' }): Promise<StaticBuildResult>;
/** Detect a completed browser output or a PRNext React project; does not run another builder. */
export function build(projectRoot: string, options: { adapter: 'auto'; dev?: false; spa?: boolean }): Promise<BuildResult | StaticBuildResult>;
export function build(projectRoot: string, options?: { adapter?: 'react'; dev?: boolean; incremental?: boolean; envMode?: 'production' | 'development' | 'test' }): Promise<BuildResult>;
export function buildStatic(projectRoot: string, options?: StaticBuildOptions): Promise<StaticBuildResult>;
export function readBuildOutput(buildDirectory: string): Promise<BuildOutput>;
export function validateBuildOutput(value: unknown): BuildOutput;
export type { DocumentContext, DocumentInitialProps, DocumentProps } from './document.cjs';
