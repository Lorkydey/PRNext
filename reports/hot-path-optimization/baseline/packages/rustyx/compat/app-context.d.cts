import type { Context, ReactElement, ReactNode } from 'react';
import type { AppRouterInstance, ReadonlyURLSearchParams } from './navigation.cjs';

export interface AppRouterSnapshot {
  pathname: string;
  search?: string;
  params?: Record<string, string | string[]>;
}
export const AppRouterContext: Context<{
  pathname: string;
  searchParams: ReadonlyURLSearchParams;
  params: Record<string, string | string[]>;
  router: AppRouterInstance;
} | null>;
export function AppRouterProvider(props: {
  router: AppRouterSnapshot;
  controller?: AppRouterInstance;
  children?: ReactNode;
}): ReactElement;
export { ReadonlyURLSearchParams } from './navigation.cjs';
