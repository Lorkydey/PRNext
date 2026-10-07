import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Execute npm's JS entry point: .cmd shims cannot be execFile'd on Windows.
// No shell interpolation, including when the project path contains spaces.
export function npmCommand(env = process.env) {
  const candidates = [env.npm_execpath];
  const directories = [path.dirname(process.execPath), ...(env.PATH || env.Path || '').split(path.delimiter)];
  for (const directory of directories.filter(Boolean)) {
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
    try {
      const npm = realpathSync(path.join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm'));
      candidates.push(npm.endsWith('.js') ? npm : path.join(path.dirname(npm), 'node_modules/npm/bin/npm-cli.js'));
    } catch {}
  }
  const cli = candidates.find(file => file && /(?:^|[/\\])npm-cli\.js$/.test(file) && existsSync(file));
  if (cli) return { command: process.execPath, args: [cli] };
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  throw new Error('Cannot locate npm-cli.js. Install Node.js with npm, or run this command through npm run.');
}

export function executeNpm(args, options = {}) {
  const npm = npmCommand();
  return execute(npm.command, [...npm.args, ...args], { windowsHide: true, ...options });
}
