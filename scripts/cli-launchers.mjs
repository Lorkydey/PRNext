import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
// These probes are noninteractive. A shell or npm shim must see EOF rather
// than inherit a pipe that stays open for the lifetime of the parent test.
export function executeLauncher(file, args, options) {
  const diagnostic = process.env.PRNEXT_LAUNCHER_DIAGNOSTICS === '1' && /^(?:powershell|pwsh)(?:\.exe)?$/i.test(path.basename(file));
  const started = Date.now();
  if (diagnostic && args.includes('-Command')) {
    args = [...args];
    const command = args.indexOf('-Command') + 1;
    args[command] = "[Console]::Error.WriteLine('PRNEXT_PS_ENGINE_READY'); " + args[command];
  }
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, async (error, stdout, stderr) => {
      if (diagnostic) console.log('[launcher-diagnostic] ' + JSON.stringify({engine:path.basename(file),elapsedMs:Date.now()-started,failed:!!error,engineReady:stderr.includes('PRNEXT_PS_ENGINE_READY'),stdout:stdout.slice(0,300),stderr:stderr.slice(0,600),signal:error?.signal,killed:error?.killed}));
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        if (diagnostic) {
          try { await diagnosePowerShell(file, options); } catch (diagnosticError) { console.log('[launcher-diagnostic] additional probe error: ' + diagnosticError.message); }
        }
        reject(error);
      } else resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}
async function diagnosePowerShell(file, options) {
  const commands = [
    ['engine', '$PSVersionTable.PSVersion.ToString(); exit 0'],
    ['discovery', '$c=Get-Command prnext -ErrorAction Stop; [Console]::WriteLine([string]$c.CommandType); [Console]::WriteLine($c.Source); exit 0'],
    ['cmd', "& $env:PRNEXT_TEST_LAUNCHER '--version'; exit $LASTEXITCODE"],
    ['ps1', "$p=[IO.Path]::ChangeExtension($env:PRNEXT_TEST_LAUNCHER,'ps1'); & $p '--version'; exit $LASTEXITCODE"],
  ];
  const entries = (options.env.PATH || '').split(path.delimiter);
  console.log('[launcher-diagnostic] ' + JSON.stringify({node:process.version,arch:process.arch,pathEntries:entries.length,duplicatePathEntries:entries.length-new Set(entries.map(p=>p.toLowerCase())).size}));
  for (const [name,command] of commands) {
    const started = Date.now();
    await new Promise(resolve => {
      const child = execFile(file, ['-NoLogo','-NoProfile','-NonInteractive','-Command',"[Console]::Error.WriteLine('PRNEXT_PS_ENGINE_READY'); "+command], options, (error,stdout,stderr)=>{
        console.log('[launcher-diagnostic] ' + JSON.stringify({probe:name,elapsedMs:Date.now()-started,failed:!!error,engineReady:stderr.includes('PRNEXT_PS_ENGINE_READY'),stdout:stdout.slice(0,500),stderr:stderr.slice(0,600),signal:error?.signal,killed:error?.killed}));resolve();
      });
      child.stdin?.end();
    });
  }
}
const execute = executeLauncher;
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const shQuote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;

// Exercise npm's actual launchers, not `node cli.mjs` or a shell profile alias.
// PATH changes and execution-policy probes apply only to child processes.
export async function checkCliLaunchers({ prefix, cwd, version, env = process.env, requirePowerShellCore = false }) {
  const windows = process.platform === 'win32';
  const bin = windows ? prefix : path.join(prefix, 'bin');
  const childEnv = { ...env };
  for (const name of Object.keys(childEnv)) if (name.toLowerCase() === 'path') delete childEnv[name];
  childEnv.PATH = [bin, path.dirname(process.execPath), env.PATH || env.Path || ''].join(path.delimiter);
  childEnv.PRNEXT_TEST_LAUNCHER = path.join(bin, windows ? 'prnext.cmd' : 'prnext');
  childEnv.PRNEXT_CLOUD_HOME = path.join(cwd, 'launcher cloud state');
  const options = { cwd, env: childEnv, timeout: 30000, maxBuffer: 1024 ** 2, windowsHide: true };
  const files = await readdir(bin);
  for (const name of ['prnext', 'prn']) {
    for (const suffix of windows ? ['', '.cmd', '.ps1'] : ['']) {
      assert.ok(files.includes(name + suffix), `npm did not generate ${name + suffix}`);
    }
  }
  if (windows) for (const suffix of ['.cmd', '.ps1']) {
    assert.match(await readFile(path.join(bin, 'prnext' + suffix), 'utf8'), /cli\.mjs/);
  }
  const shells = [];
  const powershell = (executable, label) => ({
    name: label,
    run: (args, direct = false, restricted = false) => execute(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      ...(restricted ? ['-ExecutionPolicy', 'Restricted'] : []),
      '-Command', `$ErrorActionPreference = 'Stop'; & ${direct ? '$env:PRNEXT_TEST_LAUNCHER' : 'prnext'} ${args.map(psQuote).join(' ')}; exit $LASTEXITCODE`
    ], options)
  });
  if (windows) {
    const systemRoot = env.SystemRoot || process.env.SystemRoot;
    const legacyPowerShell = path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const started = Date.now();
    try {
      const control = await execute(legacyPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString(); exit 0'], options);
      assert.match(control.stdout.trim(), /^5\./);
      console.log(`[cli-launcher] Windows PowerShell startup ${Date.now() - started} ms (${process.arch})`);
    } catch (error) {
      error.message = `Windows PowerShell failed its standalone startup control before invoking PRNext (arch=${process.arch}, elapsedMs=${Date.now()-started}, signal=${error.signal}, killed=${error.killed}, stdoutBytes=${Buffer.byteLength(error.stdout || '')}, stderrBytes=${Buffer.byteLength(error.stderr || '')}): ${error.message}`;
      throw error;
    }
    shells.push(powershell(legacyPowerShell, 'Windows PowerShell'));
    try {
      await execute('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], options);
      shells.push(powershell('pwsh.exe', 'PowerShell Core'));
    } catch (error) {
      if (error.code !== 'ENOENT' || requirePowerShellCore) throw error;
    }
    shells.push({ name: 'CMD', run(args, direct = false) {
      for (const arg of args) assert.doesNotMatch(arg, /["%!\r\n&|<>^]/, 'Unexpected CMD test argument');
      const command = `${direct ? '"%PRNEXT_TEST_LAUNCHER%"' : 'prnext'} ${args.map(arg => `"${arg}"`).join(' ')}`;
      return execute(path.join(systemRoot, 'System32/cmd.exe'), ['/d', '/v:off', '/s', '/c', `"${command}"`], { ...options, windowsVerbatimArguments: true });
    } });
  } else {
    for (const name of ['prnext', 'prn']) shells.push({
      name: `sh (${name})`,
      run: (args, direct = false) => direct
        ? execute(path.join(bin, name), args, options)
        : execute('/bin/sh', ['-c', `${name} ${args.map(shQuote).join(' ')}`], options)
    });
  }
  const requests = [];
  const probeMessage = 'Launcher reached the isolated login endpoint.';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'LAUNCHER_PROBE', message: probeMessage } }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const checks = [];
  try {
    for (const shell of shells) {
      assert.equal((await shell.run(['--version'])).stdout.trim(), version, `${shell.name}: PATH resolved a different CLI`);
      const help = (await shell.run(['--help'])).stdout;
      assert.match(help, /prnext login/);
      assert.match(help, /Windows reserves PRN/);
      const cloudHelp = (await shell.run(['login', '--help'])).stdout;
      assert.match(cloudHelp, /prnext login/);
      assert.doesNotMatch(cloudHelp, /\bprn (?:login|deploy|update|logout|whoami)\b/);
      assert.equal((await shell.run(['--version'], true)).stdout.trim(), version, `${shell.name}: absolute launcher failed`);
      const before = requests.length;
      await assert.rejects(shell.run(['login', '--server', origin, '--no-browser']), error => {
        assert.equal(error.code, 1);
        assert.ok(error.stderr.includes(probeMessage), `${shell.name}: ${error.stderr}`);
        return true;
      });
      assert.equal(requests.length, before + 1, `${shell.name}: login did not reach the selected server exactly once`);
      const request = requests.at(-1);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/cli/device');
      assert.match(request.body.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
      checks.push({ shell: shell.name, version: true, help: true, cloudHelp: true, absoluteLauncher: true, loginProbe: true });
      if (windows && shell.name.includes('PowerShell')) {
        assert.equal((await shell.run(['--version'], true, true)).stdout.trim(), version, `${shell.name}: .cmd fallback must work with a restricted script policy`);
        checks.at(-1).restrictedPolicyCmd = true;
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  return { command: 'prnext', shortcut: 'prn', shortcutSupported: !windows, checks };
}
