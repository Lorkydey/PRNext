import {deferHydration} from '@thomas.f/prnext/hydration';
import {QueryProvider,QueryHydrationBoundary} from '@thomas.f/prnext/query';
import {getQueryClient,dehydrateQuery} from '@thomas.f/prnext/query/server';
import {QueryClient} from '@tanstack/react-query';
import type {QueryClient as CommonQueryClient} from '@tanstack/react-query' with {'resolution-mode':'require'};
import type * as CommonServer from '@thomas.f/prnext/query/server' with {'resolution-mode':'require'};
import type * as CommonProvider from '@thomas.f/prnext/query' with {'resolution-mode':'require'};

const Deferred=deferHydration(async()=>({default:({title}:{title:string})=><h2>{title}</h2>}),{when:'interaction',prefetch:'idle',as:'section'});
void Deferred.preload;
const view=<Deferred title="Deferred"/>;
// @ts-expect-error widget props remain required
const missing=<Deferred/>;
// @ts-expect-error unsupported hydration strategy
deferHydration(async()=>({default:()=>null}),{when:'never'});
const client:QueryClient=getQueryClient({defaultOptions:{queries:{staleTime:30000}}});
const state=dehydrateQuery(client);
const hydrated=<QueryProvider state={state} scopeKey="account-A"><QueryHydrationBoundary state={state}>{view}</QueryHydrationBoundary></QueryProvider>;
void missing;void hydrated;
declare const commonServer:typeof CommonServer;
declare const commonProvider:typeof CommonProvider;
const commonClient:CommonQueryClient=commonServer.getQueryClient();
commonProvider.QueryProvider({client:commonClient,state:commonServer.dehydrateQuery(commonClient)});
