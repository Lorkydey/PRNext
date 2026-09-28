import dynamic, {
  type DynamicOptions,
  type DynamicOptionsLoadingProps,
  type Loader,
  type LoaderComponent,
  type LoadableComponent,
} from '@thomas.f/prnext/dynamic';
import nextDynamic from 'next/dynamic';
import type { WidgetProps } from './dynamic-component';

const DefaultWidget = dynamic(() => import('./dynamic-component'));
const NamedWidget = dynamic(() => import('./dynamic-component').then(module => module.NamedWidget));
const AliasWidget = nextDynamic(() => import('./dynamic-component'));
const ExplicitWidget = dynamic<WidgetProps>(() => import('./dynamic-component'), { ssr: false });
const FromPromise = dynamic(import('./dynamic-component'));
const FromOptions = dynamic({ loader: () => import('./dynamic-component'), ssr: false });
const loader: Loader<WidgetProps> = () => import('./dynamic-component');
const promise: LoaderComponent<WidgetProps> = import('./dynamic-component');
const Component: LoadableComponent<WidgetProps> = DefaultWidget;
const options: DynamicOptions<WidgetProps> = {
  loader, ssr: true, delay: 200, timeout: 500,
  loading({ error, isLoading, pastDelay, timedOut, retry }: DynamicOptionsLoadingProps) {
    if (error) return <button onClick={retry}>{error.message}</button>;
    return isLoading && pastDelay ? <span>{timedOut ? 'Still loading' : 'Loading'}</span> : null;
  },
};
dynamic(loader, options);
dynamic(promise);

const valid = <>
  <DefaultWidget label="default" count={2} />
  <NamedWidget enabled />
  <AliasWidget label="next alias" />
  <ExplicitWidget label="explicit" />
  <FromPromise label="promise" />
  <FromOptions label="options" />
  <Component label="component type" />
</>;
void valid;

// @ts-expect-error Required props must survive loader inference.
const missing = <DefaultWidget />;
// @ts-expect-error Named-export props must survive .then inference.
const wrongNamed = <NamedWidget enabled="yes" />;
// @ts-expect-error Package and next alias must both enforce component props.
const wrongAlias = <AliasWidget label={123} />;
// @ts-expect-error A loader resolves a component, not an already-rendered element.
dynamic(() => Promise.resolve(<div />));
// @ts-expect-error Loading error is optional/nullable, not an unconditional Error.
dynamic(loader, { loading({ error }) { return error.message; } });
// @ts-expect-error An ignored historical option is not a typed Suspense mode.
dynamic(loader, { suspense: true });
// @ts-expect-error Delay is a numeric Pages timer.
dynamic(loader, { delay: '200' });
void [missing, wrongNamed, wrongAlias];
