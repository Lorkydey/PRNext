import {NextRequest, NextResponse, NextURL} from 'next/server';

const request = new NextRequest('https://example.com/path');
const removed: boolean = request.cookies.delete('session');
const removedMany: boolean[] = request.cookies.delete(['one', 'two']);
request.cookies.set({name: 'view', value: 'compact'}).clear();
// @ts-expect-error Request cookies have no response-only attributes.
request.cookies.set({name: 'session', value: 'value', httpOnly: true});
const response = new NextResponse();
response.cookies.delete('session').set('view', 'compact', {httpOnly: true});
const url = new NextURL('https://example.com/', {forceLocale: true});
url.buildId = 'generation';
url.buildId = undefined;
const buildId: string | undefined = url.clone().buildId;
