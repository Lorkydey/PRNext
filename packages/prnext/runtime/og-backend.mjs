// Older native sharp backends can be supplied by the consuming application.
// Fall back to the bundled resvg renderer unless librsvg includes its RCE fix.
export function safeSvgBackend(backend) {
  const version = backend?.versions?.rsvg;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  return major > 2 || (major === 2 && (minor > 63 || (minor === 63 && patch >= 2)));
}
