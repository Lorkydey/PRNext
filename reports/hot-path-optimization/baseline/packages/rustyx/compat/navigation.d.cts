export interface NavigateOptions { scroll?: boolean }
export interface PrefetchOptions { onInvalidate?: () => void }
export interface AppRouterInstance {
  push(href: string, options?: NavigateOptions): void;
  replace(href: string, options?: NavigateOptions): void;
  refresh(): void;
  back(): void;
  forward(): void;
  prefetch(href: string, options?: PrefetchOptions): void;
}
export class ReadonlyURLSearchParams extends URLSearchParams {
  append(): never;
  delete(): never;
  set(): never;
  sort(): never;
}
export function useRouter(): AppRouterInstance;
export function usePathname(): string;
export function useSearchParams(): ReadonlyURLSearchParams;
export function useParams<T extends Record<string, string | string[]> = Record<string, string | string[]>>(): T;
export function useSelectedLayoutSegment(parallelRoutesKey?: string): string | null;
export function useSelectedLayoutSegments(parallelRoutesKey?: string): string[];
export const RedirectType: Readonly<{ push: 'push'; replace: 'replace' }>;
export type RedirectType = 'push' | 'replace';
export function redirect(url: string, type?: RedirectType): never;
export function permanentRedirect(url: string, type?: RedirectType): never;
export function notFound(): never;
export function unstable_rethrow(error: unknown): void;
