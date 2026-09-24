import type { LocalFontOptions, NextFont, NextFontWithVariable } from './font-types.d.cts';
declare function localFont<T extends string | undefined = undefined>(options: LocalFontOptions<T>): T extends string ? NextFontWithVariable : NextFont;
export = localFont;
