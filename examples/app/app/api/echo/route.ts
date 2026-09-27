import { cookies, headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const requestHeaders = await headers();
  const store = await cookies();
  const result = NextResponse.json({ framework: 'prnext', name: request.nextUrl.searchParams.get('name'), header: requestHeaders.get('x-example'), theme: store.get('theme')?.value || null });
  result.cookies.set('visited', '1', { httpOnly: true, sameSite: 'lax' });
  return result;
}
export async function POST(request: NextRequest) {
  const store = await cookies();
  store.set('theme', 'dark', { sameSite: 'lax' });
  return NextResponse.json({ received: await request.json() }, { status: 201 });
}
