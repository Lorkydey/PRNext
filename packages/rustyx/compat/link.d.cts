import type { AnchorHTMLAttributes, ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react';
import type { UrlObject } from './router.cjs';
export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string | UrlObject;
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
declare const Link: ForwardRefExoticComponent<LinkProps & RefAttributes<HTMLAnchorElement>>;
export default Link;
