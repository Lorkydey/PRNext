import createMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { routing } from './i18n/routing.js';
import { getAuth } from './lib/auth.js';
import { applicationOrigin } from './lib/environment.js';

const internationalize = createMiddleware(routing);
export default async function proxy(request) {
  // This reference has one configured public origin. Reconstruct it explicitly
  // after TLS termination; never let client Host/forwarding headers choose it.
  const publicUrl = new URL(applicationOrigin());
  publicUrl.pathname = request.nextUrl.pathname;
  publicUrl.search = request.nextUrl.search;
  const publicRequest = new NextRequest(publicUrl, request);
  const match = request.nextUrl.pathname.match(/^\/(en|fr)\/dashboard(?:\/|$)/);
  if (match && !(await getAuth().api.getSession({ headers: request.headers }))) {
    return NextResponse.redirect(new URL('/' + match[1] + '/sign-in', publicUrl));
  }
  return internationalize(publicRequest);
}
export const config = { matcher: ['/((?!api|_next|.*\\..*).*)'] };
