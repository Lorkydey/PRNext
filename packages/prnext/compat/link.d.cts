import type { AnchorHTMLAttributes, ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react';
import type { UrlObject } from './router.cjs';
import type {Route,TypedUrlObject} from './typed-route.cjs';
export interface LinkProps<T extends string=string> extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: Route<T> | TypedUrlObject;
  as?: string | UrlObject;
  replace?: boolean;
  scroll?: boolean;
  shallow?: boolean;
  prefetch?: boolean | null;
  locale?: string | false;
  legacyBehavior?: boolean;
  passHref?: boolean;
  children?: ReactNode;
  onNavigate?: (event: { preventDefault(): void }) => void;
}
declare function Link<T extends string>(props:LinkProps<T> & RefAttributes<HTMLAnchorElement>): import('react').ReactElement|null;
export default Link;
