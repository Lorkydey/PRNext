// Small pure helpers shared by the development panels and the local bridge.
export function safeRequestPath(raw, base = 'http://localhost') {
  try { const url = new URL(raw, base); return url.origin === new URL(base).origin ? url.pathname : url.origin + url.pathname; }
  catch { return '[Unavailable URL]'; }
}

export function routeParameters(pattern) {
  return [...String(pattern).matchAll(/\[\[\.\.\.([^\]]+)\]\]|\[\.\.\.([^\]]+)\]|\[([^\]]+)\]/g)]
    .map(match => ({ name: match[1] || match[2] || match[3], optional: Boolean(match[1]), catchAll: Boolean(match[1] || match[2]) }));
}

export function materializeRoute(pattern, values = {}) {
  let missing;
  const path = String(pattern).replace(/\[\[\.\.\.([^\]]+)\]\]|\[\.\.\.([^\]]+)\]|\[([^\]]+)\]/g, (_match, optional, all, one) => {
    const name = optional || all || one, value = String(values[name] ?? '').trim();
    if (!value) { if (!optional) missing ||= name; return ''; }
    return optional || all ? value.split('/').filter(Boolean).map(encodeURIComponent).join('/') : encodeURIComponent(value);
  }).replace(/\/{2,}/g, '/');
  if (missing) throw Error('Enter ' + missing + '.');
  return path || '/';
}

export function durationLabel(value) {
  return typeof value === 'number' && Number.isFinite(value) ? (value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(2) + ' s') : 'Not measured';
}

export function normalizeEntries(data = {}, browser = []) {
  const server = Array.isArray(data.serverLogs) ? data.serverLogs : [];
  return [...browser.map(entry => ({ ...entry, id: 'browser:' + entry.id, source: 'browser' })),
    ...server.map((entry, index) => ({ ...entry, id: 'server:' + (entry.id ?? index), time: entry.time || entry.timestamp || 0,
      level: entry.level || 'log', text: String(entry.text ?? entry.message ?? ''), source: 'server' }))]
    .sort((a, b) => a.time - b.time).slice(-750);
}

export function formatMcpConfig(server, client = 'codex') {
  if (client !== 'codex') return JSON.stringify({ mcpServers: { 'prnext-dev': client==='cursor'?{type:'stdio',...server}:server } }, null, 2);
  const lines = ['[mcp_servers.prnext-dev]', 'command = ' + JSON.stringify(server.command),
    'args = [' + (server.args || []).map(argument => JSON.stringify(argument)).join(', ') + ']'];
  if (server.env && Object.keys(server.env).length) lines.push('', '[mcp_servers.prnext-dev.env]',
    ...Object.entries(server.env).map(([key, value]) => JSON.stringify(key) + ' = ' + JSON.stringify(String(value))));
  return lines.join('\n');
}
