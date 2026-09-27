import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Partytown is supplied by the application, just like Next's experimental integration. */
export async function prepareScriptWorkers({ projectRoot, stage, assetBase }) {
  const resolve = createRequire(path.join(projectRoot, 'package.json'));
  let integrationPath, utilitiesPath;
  try {
    integrationPath = resolve.resolve('@builder.io/partytown/integration');
    utilitiesPath = resolve.resolve('@builder.io/partytown/utils');
  } catch (cause) {
    throw new Error('experimental.nextScriptWorkers requires @builder.io/partytown in the application. Install it with npm install --save-dev @builder.io/partytown, or disable this flag.', { cause });
  }
  const [integration, utilities] = await Promise.all([import(pathToFileURL(integrationPath).href), import(pathToFileURL(utilitiesPath).href)]);
  const partytownSnippet = (integration.default || integration).partytownSnippet;
  const copyLibFiles = (utilities.default || utilities).copyLibFiles;
  if (typeof partytownSnippet !== 'function' || typeof copyLibFiles !== 'function') {
    throw new Error('The installed @builder.io/partytown must export integration.partytownSnippet and utils.copyLibFiles.');
  }
  const snippet = partytownSnippet();
  if (typeof snippet !== 'string' || !snippet) throw new Error('@builder.io/partytown returned an invalid bootstrap snippet.');
  await copyLibFiles(path.join(stage, 'assets', '~partytown'));
  return { lib: assetBase + '/~partytown/', snippet };
}
