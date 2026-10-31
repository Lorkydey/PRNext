import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, realpath, rm, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { freePort, repositoryRoot } from '../support.mjs';
import { runReferenceCommand } from './process.mjs';

const execute = promisify(execFile);
const exe = name => name + (process.platform === 'win32' ? '.exe' : '');
async function postgresBin() {
  if (process.env.PRNEXT_POSTGRES_BIN) {
    const directory = path.resolve(process.env.PRNEXT_POSTGRES_BIN);
    await access(path.join(directory, exe('initdb')));
    return directory;
  }
  try {
    const { stdout } = await execute('pg_config', ['--bindir'], { windowsHide: true, timeout: 5000 });
    await access(path.join(stdout.trim(), exe('initdb')));
    return stdout.trim();
  } catch {
    const directory = process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '/usr/lib/postgresql/16/bin';
    await access(path.join(directory, exe('initdb')));
    return directory;
  }
}

// Own a fresh loopback-only cluster; never connect to a machine's existing service.
export async function startReferencePostgres() {
  const base = path.join(repositoryRoot, 'artifacts/reference-postgres');
  await mkdir(base, { recursive: true });
  const owned = await mkdtemp(path.join(base, 'cluster-'));
  const canonicalBase = await realpath(base), canonicalOwned = await realpath(owned);
  if (path.dirname(canonicalOwned) !== canonicalBase) throw new Error('Unexpected reference database directory.');
  const directory = path.join(owned, 'data'), passwordFile = path.join(owned, 'password');
  const password = randomBytes(24).toString('hex'), port = await freePort(), bin = await postgresBin();
  await writeFile(passwordFile, password, { mode: 0o600 });
  let attempted = false, closing;
  const close = () => closing ||= (async () => {
    if (attempted) {
      const running = await execute(path.join(bin, exe('pg_ctl')), ['-D', directory, 'status'], { windowsHide: true, timeout: 5000 }).then(() => true, () => false);
      if (running) await execute(path.join(bin, exe('pg_ctl')), ['-D', directory, '-m', 'fast', '-w', 'stop'], { windowsHide: true, timeout: 20000 });
    }
    if (await realpath(owned).catch(() => null) === canonicalOwned && path.dirname(canonicalOwned) === canonicalBase) {
      await rm(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  })();
  try {
    // Only bootstrap a throwaway test cluster without its final disk flush.
    // Runtime fsync/WAL settings remain PostgreSQL defaults; these workflows
    // qualify authentication and persistence, not recovery after power loss.
    await runReferenceCommand(path.join(bin, exe('initdb')), ['-D', directory, '-U', 'reference_owner', '--pwfile', passwordFile, '--auth-host=scram-sha-256', '--auth-local=trust', '-E', 'UTF8', '--no-locale', '--no-sync'], { timeout: 60000, maxBuffer: 2e6 });
    await rm(passwordFile);
    attempted = true;
    // pg_ctl uses PostgreSQL's restricted-process launcher on Windows. Running
    // postgres directly from an elevated development terminal is refused.
    await execute(path.join(bin, exe('pg_ctl')), ['-D', directory, '-l', path.join(owned, 'server.log'), '-w', '-t', '30', '-o', '-h 127.0.0.1 -p ' + port + ' -c max_connections=32 -c shared_buffers=16MB', 'start'], { windowsHide: true, timeout: 40000, maxBuffer: 2e6 });
    return { url: 'postgresql://reference_owner:' + password + '@127.0.0.1:' + port + '/postgres', close };
  } catch (error) {
    const output = await readFile(path.join(owned, 'server.log'), 'utf8').catch(() => 'No server log was produced.');
    await writeFile(path.join(base, 'last-start.log'), output.replaceAll(password, '<redacted>'));
    await close(); throw error;
  }
}
