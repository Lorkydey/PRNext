import type * as React from 'react';
import type { DehydratedState, QueryClient, QueryClientConfig } from '@tanstack/react-query';
export interface QueryProviderProps {
  children?: React.ReactNode;
  state?: DehydratedState;
  client?: QueryClient;
  scopeKey?: string | number;
  fallback?: React.ReactNode;
  /** Applied when the owned client is created. */
  options?: QueryClientConfig;
}
export function QueryProvider(props: QueryProviderProps): React.ReactElement;
export function QueryHydrationBoundary(props: { state: DehydratedState; children?: React.ReactNode }): React.ReactElement;
