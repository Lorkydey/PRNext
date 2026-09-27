import { NextResponse, type NextRequest } from 'next/server';

export const config = { matcher: ['/legacy-app', '/catalog'] };

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === '/legacy-app') {
    return NextResponse.redirect(new URL('/actions', request.url));
  }
  const response = NextResponse.rewrite(new URL('/api/catalog', request.url));
  response.headers.set('x-prnext-proxy', 'catalog');
  return response;
}
