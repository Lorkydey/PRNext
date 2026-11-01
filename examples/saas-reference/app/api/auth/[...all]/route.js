import { getAuth } from '../../../../lib/auth.js';

export const GET = request => getAuth().handler(request);
export const POST = request => getAuth().handler(request);
