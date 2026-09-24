import 'server-only';
import { createHash } from 'node:crypto';

export async function getServerData() {
  const secret = 'RUSTYX_APP_SERVER_ONLY_SENTINEL';
  await Promise.resolve();
  return { digest: createHash('sha256').update(secret).digest('hex').slice(0, 8), timestamp: new Date().toISOString() };
}
