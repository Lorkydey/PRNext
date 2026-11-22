import path from 'node:path';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const adapters = new WeakMap();
const prnextVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const nextVersion = '16.4.6';

export async function prepareDeploymentAdapter(root, input, { phase, load } = {}) {
  const legacyPath = input.experimental?.adapterPath;
  const configured = input.adapterPath ?? legacyPath ?? process.env.NEXT_ADAPTER_PATH;
  if (configured === undefined) return { input };
  if (typeof configured !== 'string' || !configured || configured.includes('\0')) {
    throw new TypeError('adapterPath must be a nonempty module path');
  }
  if (input.adapterPath && legacyPath && input.adapterPath !== legacyPath) {
    throw new Error('Conflicting adapterPath settings');
  }

  const resolve = createRequire(path.join(root, 'package.json')).resolve;
  const file = resolve(configured.startsWith('.') ? path.resolve(root, configured) : configured);
  const namespace = load ? await load(file) : await import(pathToFileURL(file).href);
  const adapter = namespace.default ?? namespace;
  if (typeof adapter !== 'object' || Array.isArray(adapter) || typeof adapter.name !== 'string' || !adapter.name.trim()) {
    throw new TypeError('Deployment adapter must declare a nonempty name');
  }
  if (adapter.prnextAdapterVersion !== undefined && adapter.prnextAdapterVersion !== 1) {
    throw new TypeError('Unsupported prnextAdapterVersion. Expected 1.');
  }
  for (const name of ['modifyConfig', 'onBuildComplete']) {
    if (adapter[name] !== undefined && typeof adapter[name] !== 'function') {
      throw new TypeError(`Adapter ${name} must be a function`);
    }
  }
  const context = { framework: 'prnext', prnextVersion, nextVersion, phase, projectDir: root };
  const modified = adapter.modifyConfig ? await adapter.modifyConfig(input, context) : input;
  if (!modified || typeof modified !== 'object' || Array.isArray(modified)) {
    throw new TypeError('Adapter modifyConfig must return a configuration object');
  }
  return { input: modified, adapter };
}

export function rememberDeploymentAdapter(config, adapter) {
  if (adapter) adapters.set(config, adapter);
  return config;
}

export async function completeDeploymentAdapter(config, { projectDir, distDir, manifest }) {
  const adapter = adapters.get(config);
  if (!adapter?.onBuildComplete) return;

  const output = JSON.parse(await readFile(path.join(distDir, 'build-output.json'), 'utf8'));
  const runtimeContract = output.server
    ? JSON.parse(await readFile(path.join(distDir, output.server.runtimeContract), 'utf8'))
    : null;
  const context = {
    framework: 'prnext',
    prnextVersion,
    nextVersion,
    projectDir,
    repoRoot: config.outputFileTracingRoot ?? projectDir,
    distDir,
    config,
    buildId: manifest.buildId,
    output,
    manifest: structuredClone(manifest),
    runtimeContract,
  };
  if (adapter.prnextAdapterVersion === undefined) {
    for (const property of ['outputs', 'routing']) {
      Object.defineProperty(context, property, {
        get() {
          throw new Error(`Deployment adapter "${adapter.name}" requires Next.js ${property}. Use context.output and context.manifest for native PRNext builds.`);
        },
      });
    }
  }
  await adapter.onBuildComplete(context);
}
