import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
import { validateAppConfig, mergeAppConfig } from './app-config.mjs';
import { scanMetadataImages } from './metadata-images.mjs';
import { pageExtensionPattern, validatePageSource } from './page-extensions.mjs';

const contentTypes = { robots: 'text/plain', sitemap: 'application/xml', manifest: 'application/manifest+json' };

export async function scanMetadataRoutes({ root, appRoot, files, routes, patterns, validatePattern, basePath, pageExtensions, appNotFound }) {
  let manifest;
  const sourceExtension = pageExtensionPattern(pageExtensions);
  for (const file of files) {
    const relative = path.relative(appRoot, file).replaceAll(path.sep, '/');
    const parts = relative.split('/');
    const name = parts.pop();
    if (parts.some(part => part.startsWith('_'))) continue;
    const dynamic = sourceExtension.test(name);
    const match = dynamic ? /^(robots|sitemap|manifest)$/.exec(name.replace(sourceExtension, '')) : /^(robots|sitemap|manifest)\.(txt|xml|json|webmanifest)$/.exec(name);
    if (!match) continue;
    const [, kind, extension] = match;
    if (dynamic) validatePageSource(file);
    if (!dynamic && !{ robots: ['txt'], sitemap: ['xml'], manifest: ['json', 'webmanifest'] }[kind].includes(extension)) continue;
    if (kind !== 'sitemap' && parts.length) continue;
    if (parts.some(part => part.startsWith('@') || /^\(\.{1,3}\)/.test(part))) throw new Error(`Parallel and intercepting metadata routes are not implemented: ${relative}.`);
    const names = dynamic ? metadataExportNames(await readFile(file, 'utf8'), file) : [];
    const multiple = kind === 'sitemap' && names.includes('generateSitemaps');
    const filename = kind === 'robots' ? 'robots.txt' : kind === 'sitemap' ? multiple ? 'sitemap' : 'sitemap.xml' : dynamic ? 'manifest.webmanifest' : name;
    const pattern = validatePattern([...parts.filter(part => !/^\([^()]+\)$/.test(part)), filename, ...(multiple ? ['[__metadata_id__]'] : [])], relative);
    const signature = pattern.replace(/\[[^\]]+\]/g, '[]');
    if (patterns.has(signature)) throw new Error(`Conflicting metadata route ${relative} and ${patterns.get(signature)} at ${pattern}.`);
    if (kind === 'manifest' && manifest) throw new Error('Multiple manifest metadata files found in the App Router root.');
    try { await access(path.join(root, 'public', pattern.slice(1))); throw new Error(`Metadata route ${pattern} conflicts with a file in public/.`); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    patterns.set(signature, relative);
    const handlerConfig = dynamic ? await validateAppConfig(file) : {};
    if (dynamic) {
      if (names.some(name => ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(name))) throw new Error(`${relative} must export a default metadata function, not HTTP methods.`);
    }
    handlerConfig.revalidate ??= false;
    if (multiple) handlerConfig.generateStaticParams = true;
    routes.push({ id: `app-metadata-${createHash('sha256').update(pattern).digest('hex').slice(0, 12)}`, pattern, router: 'app', kind: 'api', file, handlerConfig,
      cacheConfig: mergeAppConfig([handlerConfig]), metadataFile: { kind, dynamic, multiple, contentType: contentTypes[kind] } });
    if (kind === 'manifest') manifest = `${basePath}${pattern}`;
  }
  await scanMetadataImages({ root, appRoot, files, routes, patterns, validatePattern, basePath, pageExtensions, appNotFound });
  if (appNotFound && manifest) appNotFound.staticMetadata = { manifest };
  return manifest;
}

export function metadataExportNames(source, file) {
  const ast = parse(source, { sourceType: 'module', plugins: ['jsx', ...(/\.tsx?$/.test(file) ? ['typescript'] : [])] });
  return ast.program.body.flatMap(node => node.type === 'ExportNamedDeclaration' ? [node.declaration?.id?.name, ...(node.declaration?.declarations || []).map(item => item.id.name), ...node.specifiers.map(item => item.exported?.name)] : []);
}

export async function prepareMetadataRoutes(project, stage) {
  for (const route of project.routes) {
    if (!route.metadataFile) continue;
    const { kind, dynamic, contentType, multiple, image } = route.metadataFile;
    let source;
    if (dynamic) {
      const config = await validateAppConfig(route.file);
      source = `import * as source from ${JSON.stringify(route.file)};import {metadataHandler,metadataStaticParams} from '../runtime/metadata-route.mjs';export * from ${JSON.stringify(route.file)};\n`;
      if (config.revalidate === undefined) source += 'export const revalidate=false;\n';
      const options = JSON.stringify({ kind, image, multiple, contentType });
      source += `export const GET=metadataHandler(source,${options});\n`;
      if (multiple) source += `export const generateStaticParams=(props)=>metadataStaticParams(source,${options},props);\n`;
    } else {
      const body = await readFile(route.file);
      if (body.length > 16 * 1024 * 1024) throw new Error(`Metadata file ${route.file} exceeds the 16 MiB response limit.`);
      source = `export const revalidate=false;const body=Buffer.from(${JSON.stringify(body.toString('base64'))},'base64');export function GET(){return new Response(body,{headers:{'content-type':${JSON.stringify(contentType)}}});}`;
    }
    route.file = path.join(stage, '.entries', route.id + '.mjs');
    await writeFile(route.file, source);
  }
}
