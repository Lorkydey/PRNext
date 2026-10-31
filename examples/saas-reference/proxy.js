import createMiddleware from 'next-intl/middleware';
import { NextResponse } from 'next/server';
import { routing } from './i18n/routing.js';
import { getAuth } from './lib/auth.js';

const internationalize = createMiddleware(routing);
export default async function proxy(request) {
  const match = request.nextUrl.pathname.match(/^\/(en|fr)\/dashboard(?:\/|$)/);
  if (match && !(await getAuth().api.getSession({ headers: request.headers }))) {
    return NextResponse.redirect(new URL('/' + match[1] + '/sign-in', request.url));
  }
  return internationalize(request);
}
export const config = { matcher: ['/((?!api|_next|.*\\..*).*)'] };
