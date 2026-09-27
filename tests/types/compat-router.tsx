import {useRouter} from 'next/compat/router';
import {useRouter as usePRNextRouter} from 'prnext/compat/router';
import type {NextRouter} from 'next/router';
import {RouterContext} from 'next/dist/shared/lib/router-context.shared-runtime';
import {AppRouterContext} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {useContext} from 'react';
export function MigratingComponent() {
  const router: NextRouter | null = useRouter();
  const other: NextRouter | null = usePRNextRouter();
  const internal: NextRouter | null = useContext(RouterContext);
  useContext(AppRouterContext)?.prefetch('/');
  // @ts-expect-error The compat router can be null outside Pages.
  const required: NextRouter = useRouter();
  return <p>{router?.pathname}{other?.pathname}{required.pathname}{internal?.pathname}</p>;
}
