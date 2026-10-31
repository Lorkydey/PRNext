export function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error('Missing required configuration: ' + name);
  return value;
}

export function applicationOrigin() {
  let url;
  try { url = new URL(required('BETTER_AUTH_URL')); } catch { throw new Error('BETTER_AUTH_URL must be an absolute HTTP(S) origin.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new Error('BETTER_AUTH_URL requires HTTPS, except on loopback development hosts.');
  }
  return url.origin;
}
