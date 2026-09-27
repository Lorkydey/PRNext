export interface NextFont {
  className: string;
  style: { fontFamily: string; fontWeight?: number; fontStyle?: string };
}
export interface NextFontWithVariable extends NextFont { variable: string }
export interface FontOptions<T extends string | undefined = undefined> {
  display?: 'auto' | 'block' | 'swap' | 'fallback' | 'optional';
  preload?: boolean;
  fallback?: string[];
  variable?: T;
}
export interface LocalFontOptions<T extends string | undefined = undefined> extends FontOptions<T> {
  src: string | Array<{ path: string; weight?: string; style?: string }>;
  weight?: string;
  style?: string;
  adjustFontFallback?: 'Arial' | 'Times New Roman' | false;
  declarations?: Array<{ prop: string; value: string }>;
}
export interface GoogleFontOptions<T extends string | undefined = undefined> extends FontOptions<T> {
  weight?: string | string[];
  style?: string | string[];
  subsets?: string[];
  axes?: string[];
  adjustFontFallback?: boolean;
}
