/// <reference path="./fetch.d.cts" />
export interface CacheLife { stale?: number; revalidate?: number; expire?: number }
export function cacheLife(profile: string | CacheLife): void;

/** Storage interface accepted by the cacheHandlers project option. */
export interface CacheEntry {
  value: ReadableStream<Uint8Array>;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}
export interface CacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined>;
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<number>;
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}
export function cacheTag(...tags: string[]): void;

export interface UnstableCacheOptions {
  tags?: string[];
  revalidate?: number | false;
}
export function unstable_cache<T extends (...args: any[]) => Promise<any>>(
  callback: T,
  keyParts?: string[],
  options?: UnstableCacheOptions,
): T;
export function revalidateTag(tag: string, profile?: string | { expire?: number }): void;
export function updateTag(tag: string): void;
export function revalidatePath(path: string, type?: 'page' | 'layout'): void;
export function unstable_noStore(): void;
export function refresh(): void;
