import type { NextApiRequest, NextApiResponse } from '@thomas.f/prnext';
export default function cookies(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Set-Cookie', ['first=1; Path=/; HttpOnly', 'second=2; Path=/; SameSite=Lax']);
  res.json({ ok: true });
}
