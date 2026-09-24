import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export function cargoEnvironment() {
  const local = path.join(repositoryRoot, '.toolchain');
  if (!existsSync(path.join(local, 'cargo/bin/cargo'))) return { ...process.env };
  return {
    ...process.env,
    CARGO_HOME: path.join(local, 'cargo'),
    RUSTUP_HOME: path.join(local, 'rustup'),
    PATH: `${path.join(local, 'cargo/bin')}${path.delimiter}${process.env.PATH || ''}`,
  };
}
export function cargo(args, options = {}) {
  return spawn('cargo', args, { cwd: repositoryRoot, env: cargoEnvironment(), stdio: 'inherit', ...options });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const child = cargo(process.argv.slice(2));
  child.on('error', error => { console.error(`Rust toolchain unavailable: ${error.message}. Install Rust from https://rustup.rs.`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
