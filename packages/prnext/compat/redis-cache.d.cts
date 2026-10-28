/// <reference types="node" />
export interface RedisCacheOptions {
  /** Unique application namespace, shared by its replicas. */
  namespace: string;
  /** Runtime environment variable; the URL is never embedded in a build. Default REDIS_URL. */
  urlEnv?: string;
  /** An already-connected node-redis client. Its lifecycle remains yours. */
  client?: {readonly isReady?: boolean; withTypeMapping(mapping: {36: BufferConstructor}): {sendCommand(args: (string | Buffer)[], options?: {abortSignal?: AbortSignal}): Promise<unknown>}};
  leaseMs?: number;
  waitMs?: number;
  commandTimeoutMs?: number;
  maxAgeSeconds?: number;
}
interface CacheEntry {value: ReadableStream<Uint8Array>; tags: string[]; timestamp: number; stale: number; revalidate: number; expire: number}
interface Lease {token: string; started: number; epoch: string; incarnation: string; release(): Promise<void>}
export declare function createRedisCache(options: RedisCacheOptions): {
  get(key: string, softTags?: string[]): Promise<CacheEntry | undefined>;
  set(key: string, entry: Promise<CacheEntry>, options?: {lease?: Lease; softTags?: string[]}): Promise<void>;
  acquire(key: string, options?: {signal?: AbortSignal}): Promise<Lease>;
  refreshTags(): Promise<void>;
  getExpiration(): Promise<number>;
  updateTags(tags: string[], durations?: {expire: number}): Promise<void>;
  close(): Promise<void>;
};

export interface IncrementalRedisLease {token: string; epoch: string; incarnation: string; startedAt: number}
/** Configure its returned constructor as cacheHandler; Cache Components use createRedisCache separately. */
export declare function createRedisIncrementalCache(options: RedisCacheOptions): new (context?: unknown) => {
  readonly prnextLeaseVersion: 1;
  acquire(key: string, options?: {signal?: AbortSignal}): Promise<IncrementalRedisLease>;
  release(key: string, lease: IncrementalRedisLease): Promise<void>;
  get(key: string, context?: {tags?: string[]; softTags?: string[]}): Promise<{value: unknown; lastModified: number; isStale?: boolean} | null>;
  set(key: string, value: unknown, context?: {prnextLease?: IncrementalRedisLease; tags?: string[]; softTags?: string[]; cacheControl?: {revalidate: number | false}}): Promise<boolean>;
  revalidateTag(tags: string | string[], durations?: {expire?: number}): Promise<void>;
  resetRequestCache(): void;
  close(): Promise<void>;
};
