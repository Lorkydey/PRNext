import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const expectedTopics = ['quickstart', 'routing', 'data', 'compatibility', 'deployment', 'troubleshooting'];

// These guides ship as package API. Validate their distribution and local links
// on every release, independently of a website or a native server installation.
export async function verifyAiDocumentation(root, pkg) {
  if (!pkg.files?.includes('AI.md') || !pkg.files?.includes('docs/ai/')) {
    throw new Error('The npm files list must include AI.md and docs/ai/.');
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'docs/ai/manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.topics) ||
      JSON.stringify(manifest.topics.map(topic => topic.id)) !== JSON.stringify(expectedTopics)) {
    throw new Error('AI documentation manifest has missing, duplicate or unexpected topics.');
  }
  const files = ['AI.md'];
  for (const topic of manifest.topics) {
    if (topic.file !== `docs/ai/${topic.id}.md` || typeof topic.title !== 'string' || !topic.title.trim() || /[\r\n\x00-\x1f]/.test(topic.title)) {
      throw new Error(`Invalid AI documentation topic: ${topic.id}`);
    }
    files.push(topic.file);
  }
  for (const file of [...files, 'docs/ai/manifest.json']) {
    if (pkg.exports?.[`./${file}`] !== `./${file}`) throw new Error(`Missing npm documentation export: ${file}`);
  }
  let totalBytes = 0;
  for (const file of files) {
    const content = await readFile(path.join(root, file), 'utf8');
    const bytes = Buffer.byteLength(content);
    totalBytes += bytes;
    if (!/^# .+/m.test(content) || bytes > (file === 'AI.md' ? 6_000 : 32_000)) {
      throw new Error(`AI guide is missing its heading or exceeds its focused reading budget: ${file}`);
    }
    for (const match of content.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
      const link = match[1];
      if (link.startsWith('#') || /^https?:\/\//.test(link)) continue;
      const target = path.resolve(root, path.dirname(file), decodeURIComponent(link.split('#')[0]));
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`AI guide link leaves the package: ${file}: ${link}`);
      try { await access(target); }
      catch { throw new Error(`Broken AI guide link: ${file}: ${link}`); }
    }
  }
  if (totalBytes > 100_000) throw new Error('AI documentation exceeds the total focused reading budget.');
  await access(path.join(root, 'runtime/ai-docs.mjs'));
  return { topics: manifest.topics.length, files: files.length, bytes: totalBytes };
}
