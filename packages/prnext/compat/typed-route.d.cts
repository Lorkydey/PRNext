import type {UrlObject} from './router.cjs';
declare global { namespace PRNext { interface RouteMap {} } }
export type RoutePattern = keyof PRNext.RouteMap extends never ? string : Extract<keyof PRNext.RouteMap,string>;
export type RouteParameters<P extends string> = P extends keyof PRNext.RouteMap ? PRNext.RouteMap[P] : Record<string,string|string[]|undefined>;
type Suffix = '' | `?${string}` | `#${string}`;
type External = `https://${string}` | `http://${string}` | `mailto:${string}` | `tel:${string}` | `#${string}` | `?${string}`;
type Expand<P extends string> = P extends `${infer A}/[[...${string}]]` ? A | `${A}/${string}` : P extends `${infer A}[${string}]${infer B}` ? `${A}${string}${Expand<B>}` : P;
type Strip<P extends string> = P extends `${infer A}#${string}` ? Strip<A> : P extends `${infer A}?${string}` ? A : P;
type Segment<S extends string> = S extends ''|'.'|'..' ? false : S extends `${string}/${string}`|`${string}\\${string}` ? false : true;
type Segments<S extends string> = S extends `${infer H}/${infer R}` ? Segment<H> extends true ? Segments<R> : false : Segment<S>;
type Match<P extends string,S extends string> = P extends `${infer A}/[[...${string}]]` ? S extends A ? true : Match<`${A}/[...rest]`,S> : P extends `[...${string}]` ? Segments<S> : P extends `${infer H}/${infer R}` ? S extends `${infer V}/${infer T}` ? H extends `[${string}]` ? Segment<V> extends true ? Match<R,T> : false : H extends V ? Match<R,T> : false : false : P extends `[${string}]` ? Segment<S> : P extends S ? true : false;
type Matching<S extends string,P extends string=RoutePattern> = P extends unknown ? Match<P,S> extends true ? true : never : never;
type Suggestions = Expand<RoutePattern> extends infer P extends string ? `${P}${Suffix}` : never;
export type Route<T extends string=string> = keyof PRNext.RouteMap extends never ? T : string extends T ? Suggestions|External : T extends External ? T : true extends Matching<Strip<T>> ? T : never;
export type TypedUrlObject = keyof PRNext.RouteMap extends never ? UrlObject : {[P in RoutePattern]: Omit<UrlObject,'pathname'|'query'> & {pathname:P} & ({} extends RouteParameters<P> ? {query?:RouteParameters<P>&Record<string,unknown>} : {query:RouteParameters<P>&Record<string,unknown>})}[RoutePattern];
export function route<P extends RoutePattern>(pattern:P,...args:{} extends RouteParameters<P> ? [params?:RouteParameters<P>] : [params:RouteParameters<P>]): Route;
