export const defaultPageExtensions = ['tsx', 'ts', 'jsx', 'js', 'mjs', 'cjs'];

export function pageExtensionPattern(extensions = defaultPageExtensions) {
  if (!Array.isArray(extensions) || !extensions.length || extensions.length > 64 || extensions.some(value => typeof value !== 'string' || value.length > 100 || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value))) {
    throw new Error('pageExtensions must be a non-empty array of file suffixes without a leading dot or path separator.');
  }
  return new RegExp(`\\.(?:${[...new Set(extensions)].sort((a, b) => b.length - a.length).map(value => value.replaceAll('.', '\\.')).join('|')})$`);
}

export function validatePageSource(file) {
  if (!/\.(?:[cm]?js|jsx|tsx?)$/.test(file)) throw new Error(`The pageExtensions entry ${file} requires an unsupported source loader. PRNext currently compiles JavaScript and TypeScript, including compound suffixes such as .page.tsx.`);
}
