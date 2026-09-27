import type { ComponentType, ReactNode } from 'react';

export type LoaderComponent<P = {}> = Promise<ComponentType<P> | { default: ComponentType<P> }>;
export type Loader<P = {}> = (() => LoaderComponent<P>) | LoaderComponent<P>;

export interface DynamicOptionsLoadingProps {
  error?: Error | null;
  isLoading?: boolean;
  pastDelay?: boolean;
  retry?: () => void;
  timedOut?: boolean;
}

export interface DynamicOptions<P = {}> {
  loading?: (props: DynamicOptionsLoadingProps) => ReactNode;
  loader?: Loader<P>;
  ssr?: boolean;
  /** Pages loading-state delay in milliseconds; ignored by the App Router. */
  delay?: number;
  /** Pages timedOut indicator in milliseconds; does not cancel the loader. Ignored by App. */
  timeout?: number;
}

export type LoadableOptions<P = {}> = DynamicOptions<P>;
export type LoadableFn<P = {}> = (options: LoadableOptions<P>) => ComponentType<P>;
export type LoadableComponent<P = {}> = ComponentType<P>;

/** App Router usage requires a loader function; ssr:false belongs in a Client Component. */
export default function dynamic<P = {}>(
  loader: Loader<P> | DynamicOptions<P>,
  options?: DynamicOptions<P>,
): ComponentType<P>;
