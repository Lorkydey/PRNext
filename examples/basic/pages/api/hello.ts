import type { NextApiRequest, NextApiResponse } from 'rustyx';

export default function hello(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('x-rustyx-api', 'npm');
  if (req.method === 'POST') return res.status(201).json({ received: req.body });
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.setHeader('Allow', 'GET, HEAD, POST').status(405).json({ error: 'Method not allowed' });
  res.status(200).json({ framework: 'rustyx', hello: req.query.name || 'world' });
}
