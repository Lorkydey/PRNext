import { lstat, readdir, readFile, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import picomatch from 'picomatch';
import { prospectivePath } from './state.mjs';

const MiB = 1048576;
const alwaysExcluded = (name) =>
  /^(?:node_modules|\.git|\.hg|\.svn|\.next|\.local|\.npm|\.ssh|\.aws|\.azure|\.vercel|coverage|\.DS_Store|__MACOSX)$/i.test(
    name
  ) ||
  /^\.prnext(?:[.-]|$)/i.test(name) ||
  /^\.env(?:\.|$)/i.test(name) ||
  /^(?:\.npmrc|\.yarnrc\.yml|\.netrc|id_rsa|id_ed25519)$/i.test(name) ||
  /\.(?:pem|key|p12|pfx|log|tsbuildinfo)$/i.test(name);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
async function ignoreRules(root) {
  const rules = [];
  for (const name of ['.gitignore', '.prnextignore']) {
    const filename = path.join(root, name);
    let source;
    try {
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
        throw new Error(`${name} must be a regular file of at most 64 KiB.`);
      source = await readFile(filename, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (let pattern of source.split(/\r?\n/)) {
      pattern = pattern.trim();
      if (!pattern || pattern.startsWith('#')) continue;
      const include = pattern.startsWith('!');
      if (include) pattern = pattern.slice(1);
      const anchored = pattern.startsWith('/');
      pattern = pattern.replace(/^\//, '').replace(/\/$/, '');
      if (!pattern || pattern.length > 512)
        throw new Error(`Invalid pattern in ${name}.`);
      const match = picomatch(
        !anchored && !pattern.includes('/') ? `**/${pattern}` : pattern,
        { dot: true }
      );
      rules.push({
        include,
        match,
        prefix:
          !anchored && !pattern.includes('/')
            ? ''
            : picomatch.scan(pattern).base
      });
      if (rules.length > 2000)
        throw new Error('Too many deployment ignore patterns.');
    }
  }
  const ignored = (name) => {
    let ignored = false;
    const parts = name.split('/');
    const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    for (const rule of rules)
      if (prefixes.some((prefix) => rule.match(prefix)))
        ignored = !rule.include;
    return ignored;
  };
  ignored.canReinclude = (directory) =>
    rules.some(
      (rule) =>
        rule.include &&
        (!rule.prefix ||
          rule.prefix === directory ||
          rule.prefix.startsWith(directory + '/') ||
          directory.startsWith(rule.prefix + '/'))
    );
  return ignored;
}

/** Build a deterministic, bounded ZIP without following links or running code. */
export async function archiveProject(
  directory,
  {
    maxArchiveBytes = 7 * MiB,
    maxSourceBytes = 100 * MiB,
    maxFileBytes = 15 * MiB,
    maxFiles = 3000,
    signal,
    outputFile
  } = {}
) {
  const root = await realpath(directory);
  if (outputFile) {
    const relative = path.relative(root,await prospectivePath(outputFile));
    if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('Temporary archive must be outside the project.');
  }
  const output = outputFile ? await open(outputFile, 'wx', 0o600) : null;
  const hash = createHash('sha256');
  const chunks = [];
  const append = async (...parts) => {
    for (const part of parts) { hash.update(part); if (output) await output.writeFile(part); else chunks.push(part); }
  };
  try {
  const ignored = await ignoreRules(root);
  const files = [],
    central = [],
    names = new Set();
  let expanded = 0,
    offset = 0,
    centralSize = 0,
    visited = 0,
    excluded = 0,
    packageJson;
  async function walk(relative = '') {
    for (const entry of (
      await readdir(path.join(root, relative), { withFileTypes: true })
    ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      signal?.throwIfAborted();
      if (++visited > 20000)
        throw new Error(
          'Too many source entries. Deploy a smaller project folder.'
        );
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (alwaysExcluded(entry.name)) {
        excluded++;
        continue;
      }
      if (
        /[\x00-\x1f\x7f\\:]/.test(name) ||
        name
          .split('/')
          .some(
            (p) =>
              p === '..' ||
              /[. ]$/.test(p) ||
              /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
          ) ||
        Buffer.byteLength(name) > 1024
      )
        throw new Error(
          'A source filename is not portable. Rename files with control characters, backslashes or trailing dots/spaces.'
        );
      if (entry.isSymbolicLink()) {
        if (ignored(name)) {
          excluded++;
          continue;
        }
        throw new Error(
          `Symbolic links are not uploaded: ${name}. Exclude it in .prnextignore.`
        );
      }
      if (entry.isDirectory()) {
        if (ignored(name) && !ignored.canReinclude(name)) {
          excluded++;
          continue;
        }
        await walk(name);
        continue;
      }
      if (ignored(name)) {
        excluded++;
        continue;
      }
      if (!entry.isFile())
        throw new Error(`Only regular source files can be uploaded: ${name}`);
      if (files.length >= maxFiles)
        throw new Error(
          `Source exceeds ${maxFiles} files. Add exclusions to .prnextignore.`
        );
      const folded = name.toLowerCase();
      if (names.has(folded))
        throw new Error(`Case-conflicting source filename: ${name}`);
      names.add(folded);
      const filename = path.join(root, name);
      const before = await lstat(filename);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.size > maxFileBytes
      )
        throw new Error(
          `Source file is not regular or exceeds ${maxFileBytes / MiB} MiB: ${name}`
        );
      if (expanded + before.size > maxSourceBytes)
        throw new Error(
          `Expanded sources exceed ${maxSourceBytes / MiB} MiB. Add exclusions to .prnextignore.`
        );
      // Recheck identity after opening and after reading to catch concurrent edits.
      const handle = await open(filename, 'r');
      let contents;
      try {
        const opened = await handle.stat();
        const current = await lstat(filename);
        if (
          current.isSymbolicLink() ||
          !opened.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size
        )
          throw new Error(
            `Source changed while packaging: ${name}. Try again.`
          );
        contents = Buffer.alloc(opened.size);
        let read = 0;
        while (read < contents.length) {
          const next = await handle.read(
            contents,
            read,
            contents.length - read,
            read
          );
          if (!next.bytesRead)
            throw new Error(
              `Source changed while packaging: ${name}. Try again.`
            );
          read += next.bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
          throw new Error(
            `Source changed while packaging: ${name}. Try again.`
          );
      } finally {
        await handle.close();
      }
      if (name === 'package.json') {
        try {
          packageJson = JSON.parse(contents.toString('utf8'));
        } catch {
          throw new Error('package.json is not valid JSON.');
        }
        if (
          !packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)
        )
          throw new Error(
            'package.json must contain an object.'
          );
      }
      let compressed = deflateRawSync(contents, { level: 6 });
      // The server rejects expansion ratios over 150. Store very repetitive files.
      const method =
        compressed.length < contents.length &&
        contents.length / Math.max(1, compressed.length) <= 140
          ? 8
          : 0;
      if (!method) compressed = contents;
      const encoded = Buffer.from(name),
        crc = crc32(contents);
      const header = Buffer.alloc(30),
        record = Buffer.alloc(46);
      header.writeUInt32LE(0x04034b50);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x800, 6);
      header.writeUInt16LE(method, 8);
      header.writeUInt16LE(33, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(contents.length, 22);
      header.writeUInt16LE(encoded.length, 26);
      record.writeUInt32LE(0x02014b50);
      record.writeUInt16LE(0x0314, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x800, 8);
      record.writeUInt16LE(method, 10);
      record.writeUInt16LE(33, 14);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(compressed.length, 20);
      record.writeUInt32LE(contents.length, 24);
      record.writeUInt16LE(encoded.length, 28);
      record.writeUInt32LE(0x81a40000, 38);
      record.writeUInt32LE(offset, 42);
      offset += header.length + encoded.length + compressed.length;
      centralSize += record.length + encoded.length;
      if (offset + centralSize + 22 > maxArchiveBytes)
        throw new Error(
          `Source archive exceeds ${(maxArchiveBytes / MiB).toFixed(0)} MiB. Exclude unnecessary files in .prnextignore.`
        );
      await append(header, encoded, compressed);
      central.push(record, encoded);
      files.push(name);
      expanded += contents.length;
    }
  }
  await walk();
  if (!files.includes('index.html') && (typeof packageJson?.scripts?.build !== 'string' || !packageJson.scripts.build.trim()))
    throw new Error(
      'Include index.html for a plain site, or package.json with a production build script; do not exclude it.'
    );
  packageJson ||= {};
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  await append(...central, end);
  const buffer = output ? undefined : Buffer.concat(chunks);
  return {
    buffer,
    path: outputFile,
    size: offset + centralSize + 22,
    files,
    expandedBytes: expanded,
    excluded,
    digest: hash.digest('hex'),
    packageJson
  };
  } finally { await output?.close(); }
}
