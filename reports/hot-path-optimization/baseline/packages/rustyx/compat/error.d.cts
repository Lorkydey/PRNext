import { Component, type ReactElement } from 'react';
import type { NextPageContext } from './index.d.ts';

export interface ErrorProps {
  statusCode: number;
  hostname?: string;
  title?: string;
  withDarkMode?: boolean;
}
export default class ErrorPage<Props = {}> extends Component<Props & ErrorProps> {
  static displayName: string;
  static getInitialProps(context: NextPageContext): ErrorProps | Promise<ErrorProps>;
  static origGetInitialProps: typeof ErrorPage.getInitialProps;
  render(): ReactElement;
}
