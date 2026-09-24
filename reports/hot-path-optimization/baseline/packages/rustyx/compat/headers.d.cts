export interface CookieOptions {
  path?: string;
  domain?: string;
  expires?: Date | number;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: boolean | 'lax' | 'strict' | 'none';
  priority?: 'low' | 'medium' | 'high';
  partitioned?: boolean;
}
export interface Cookie extends CookieOptions { name: string; value: string }
export interface CookieStore extends Iterable<[string, Cookie]> {
  readonly size: number;
  get(name: string | { name: string }): Cookie | undefined;
  getAll(name?: string | { name: string }): Cookie[];
  has(name: string): boolean;
  set(name: string, value: string, options?: CookieOptions): CookieStore;
  set(cookie: Cookie): CookieStore;
  delete(name: string | { name: string; path?: string; domain?: string }): CookieStore;
  toString(): string;
}
export function headers(): Promise<Omit<Headers, 'set' | 'append' | 'delete'>>;
export function cookies(): Promise<CookieStore>;
export interface DraftMode { readonly isEnabled: boolean; enable(): void; disable(): void }
export function draftMode(): Promise<DraftMode>;
