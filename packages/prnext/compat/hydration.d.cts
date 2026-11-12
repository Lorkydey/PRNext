import type * as React from 'react';
export interface DeferredHydrationOptions {
  when?: 'visible' | 'idle' | 'interaction';
  prefetch?: false | 'visible' | 'idle';
  as?: keyof React.JSX.IntrinsicElements;
  rootMargin?: string;
  idleTimeout?: number;
  fallback?: React.ReactNode;
}
export function deferHydration<P extends object>(
  loader: () => Promise<{ default: React.ComponentType<P> }>,
  options?: DeferredHydrationOptions,
): React.MemoExoticComponent<React.ComponentType<P>> & { preload(): Promise<{ default: React.ComponentType<P> }> };
