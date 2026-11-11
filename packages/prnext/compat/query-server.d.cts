import type { DehydrateOptions, DehydratedState, QueryClient, QueryClientConfig } from '@tanstack/query-core';
/** One QueryClient per PRNext request. Configure it on the first call. */
export function getQueryClient(options?: QueryClientConfig): QueryClient;
/** An unchanged standard snapshot is shared across calls and Flight boundaries. */
export function dehydrateQuery(client?: QueryClient, options?: DehydrateOptions): DehydratedState;
