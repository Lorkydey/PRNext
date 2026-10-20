import { mkdir, lstat, readFile, realpath, writeFile, rm, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { rename } from '../fs.mjs';

// Resolve existing parents too when a destination has not been created yet.
// On macOS, for example, /var and /private/var refer to the same directory.
export async function prospectivePath(value) {
  let parent = path.resolve(value);
  const missing = [];
  for (;;) {
    try { return path.join(await realpath(parent), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(parent) === parent) throw error;
      missing.unshift(path.basename(parent));
      parent = path.dirname(parent);
    }
  }
}

export function cloudOrigin(value = 'https://app.prnext.dev') {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'Cloud server must be an HTTPS origin or a loopback HTTP origin.'
    );
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw new Error(
      'Cloud server must be an HTTPS origin or a loopback HTTP origin.'
    );
  return url.origin;
}
export async function readState(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
      throw new Error('Invalid PRNext Cloud state file.');
    const value = JSON.parse(await readFile(filename, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object')
      throw new Error('Invalid PRNext Cloud state file.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function writeState(filename, data) {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error('PRNext Cloud state directory cannot be a link.');
  await readState(filename);
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600
    });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}
export function credentialPath(origin, env = process.env) {
  const directory = path.resolve(
    env.PRNEXT_CLOUD_HOME || path.join(homedir(), '.prnext', 'cloud')
  );
  return path.join(
    directory,
    createHash('sha256').update(cloudOrigin(origin)).digest('hex') + '.json'
  );
}
export const linkPath = (directory) =>
  path.join(directory, '.prnext-cloud', 'project.json');
export async function withStateLock(filename, task) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  if ((await lstat(path.dirname(filename))).isSymbolicLink())
    throw new Error('Cloud state directory cannot be a link.');
  const marker = { pid: process.pid, nonce: randomBytes(16).toString('hex') };
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(filename, JSON.stringify(marker), {
        flag: 'wx',
        mode: 0o600
      });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readState(filename);
      let active = true;
      if (Number.isSafeInteger(previous?.pid) && previous.pid > 0) {
        try {
          process.kill(previous.pid, 0);
        } catch (failure) {
          if (failure.code === 'ESRCH') active = false;
        }
      }
      if (active || attempt > 0)
        throw new Error(
          'Another PRNext Cloud command is using this project. Wait for it to finish.'
        );
      if ((await readState(filename))?.nonce === previous.nonce)
        await rm(filename);
    }
  }
  try {
    return await task();
  } finally {
    if ((await readState(filename))?.nonce === marker.nonce) await rm(filename);
  }
}
export async function saveLink(directory, link) {
  await writeState(linkPath(directory), link);
  const gitignore = path.join(directory, '.gitignore');
  let contents = '';
  try {
    const stat = await lstat(gitignore);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
      throw new Error(
        'Cannot safely update .gitignore; ignore .prnext-cloud/ manually.'
      );
    contents = await readFile(gitignore, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (
    !contents
      .split(/\r?\n/)
      .some((line) =>
        ['.prnext-cloud/', '/.prnext-cloud/', '.prnext-cloud'].includes(line)
      )
  )
    await writeFile(
      gitignore,
      contents +
        (contents.endsWith('\n') || !contents ? '' : '\n') +
        '.prnext-cloud/\n'
    );
}
