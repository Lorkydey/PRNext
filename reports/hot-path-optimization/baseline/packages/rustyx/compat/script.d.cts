import type { JSX, ReactNode, ScriptHTMLAttributes } from 'react';

export interface ScriptProps extends ScriptHTMLAttributes<HTMLScriptElement> {
  strategy?: 'afterInteractive' | 'lazyOnload' | 'beforeInteractive' | 'worker';
  id?: string;
  onLoad?: (event: any) => void;
  onReady?: () => void | null;
  onError?: (event: any) => void;
  children?: ReactNode;
  stylesheets?: string[];
}

/** @deprecated Use ScriptProps instead. */
export type Props = ScriptProps;
export declare function handleClientScriptLoad(props: ScriptProps): void;
export declare function initScriptLoader(scriptLoaderItems: ScriptProps[]): void;
export default function Script(props: ScriptProps): JSX.Element | null;
