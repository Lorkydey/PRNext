import { createHash } from 'node:crypto';

export const revalidate = 30;

export function GET() {
  const generatedAt = new Date().toISOString();
  return Response.json({
    products: [{ id: 'rustyx', name: 'Rustyx', language: 'Rust + TypeScript' }],
    generatedAt,
    revision: createHash('sha256').update(generatedAt).digest('hex').slice(0, 12),
  });
}
