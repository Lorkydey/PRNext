import { Component } from 'react';
import type { AppContext, AppInitialProps, AppProps } from './index.d.ts';
export type { AppContext, AppInitialProps, AppProps } from './index.d.ts';

export default class App<P = {}, CP = {}, S = {}> extends Component<P & AppProps<CP>, S> {
  static origGetInitialProps(context: AppContext): Promise<AppInitialProps>;
  static getInitialProps(context: AppContext): Promise<AppInitialProps>;
  render(): import('react').ReactElement;
}
